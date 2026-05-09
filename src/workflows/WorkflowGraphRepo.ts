import type Database from "better-sqlite3";
import type { WorkflowGraph, WorkflowPatch } from "./types.js";
import { validateWorkflowGraph, validateWorkflowPatch } from "./validation.js";

type WorkflowGraphRow = {
  id: number;
  project_id: number;
  orchestration_id: number | null;
  title: string;
  graph_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

type WorkflowPatchRow = {
  id: number;
  graph_id: number;
  project_id: number;
  orchestration_id: number | null;
  base_revision: number;
  resulting_revision: number;
  patch_json: string;
  source: string;
  reason: string;
  created_at: string;
};

export interface PersistedWorkflowGraph {
  id: number;
  projectId: number;
  orchestrationId: number | null;
  title: string;
  graph: WorkflowGraph;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedWorkflowPatch {
  id: number;
  graphId: number;
  projectId: number;
  orchestrationId: number | null;
  baseRevision: number;
  resultingRevision: number;
  patch: WorkflowPatch;
  source: string;
  reason: string;
  createdAt: string;
}

export class WorkflowGraphRepo {
  constructor(private readonly db: Database.Database) {}

  getByProject(projectId: number): PersistedWorkflowGraph | null {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM workflow_graphs
        WHERE project_id = ?
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT 1
      `,
      )
      .get(projectId) as WorkflowGraphRow | undefined;
    return row ? mapGraphRow(row) : null;
  }

  getByOrchestration(orchestrationId: number): PersistedWorkflowGraph | null {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM workflow_graphs
        WHERE orchestration_id = ?
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT 1
      `,
      )
      .get(orchestrationId) as WorkflowGraphRow | undefined;
    return row ? mapGraphRow(row) : null;
  }

  createGraph(projectId: number, orchestrationId: number | null, title: string, initialGraph: WorkflowGraph): PersistedWorkflowGraph {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      throw new Error("Workflow graph title is required.");
    }
    assertValidGraph(initialGraph);
    const result = this.db
      .prepare(
        `
        INSERT INTO workflow_graphs (
          project_id,
          orchestration_id,
          title,
          graph_json,
          revision,
          created_at,
          updated_at
        )
        VALUES (
          @projectId,
          @orchestrationId,
          @title,
          @graphJson,
          @revision,
          @createdAt,
          @updatedAt
        )
      `,
      )
      .run({
        projectId,
        orchestrationId,
        title: cleanTitle,
        graphJson: serializeJson(initialGraph),
        revision: initialGraph.revision,
        createdAt: initialGraph.createdAt,
        updatedAt: initialGraph.updatedAt,
      });
    return requireGraph(this.getGraphSnapshot(Number(result.lastInsertRowid)), Number(result.lastInsertRowid));
  }

  savePatch(graphId: number, patch: WorkflowPatch, updatedGraph: WorkflowGraph): PersistedWorkflowPatch {
    const patchResult = validateWorkflowPatch(patch);
    if (!patchResult.ok || !patchResult.value) {
      throw new Error(`Workflow patch is invalid: ${patchResult.errors.join("; ")}`);
    }
    if (patch.baseRevision === undefined) {
      throw new Error("Workflow patch baseRevision is required for persistence.");
    }
    assertValidGraph(updatedGraph);
    if (updatedGraph.revision !== patch.baseRevision + 1) {
      throw new Error(
        `Workflow patch resulting revision mismatch: expected ${patch.baseRevision + 1}, got ${updatedGraph.revision}.`,
      );
    }

    const tx = this.db.transaction(() => {
      const existing = this.getGraphSnapshot(graphId);
      if (!existing) {
        throw new Error(`Workflow graph ${graphId} not found.`);
      }
      if (existing.revision !== patch.baseRevision) {
        throw new Error(`Workflow patch is stale: graph revision ${existing.revision} does not match baseRevision ${patch.baseRevision}.`);
      }
      if (patch.graphId && patch.graphId !== existing.graph.id) {
        throw new Error(`Workflow patch graphId ${patch.graphId} does not match workflow graph ${existing.graph.id}.`);
      }
      if (updatedGraph.id !== existing.graph.id) {
        throw new Error(`Updated workflow graph id ${updatedGraph.id} does not match stored graph ${existing.graph.id}.`);
      }

      const updateResult = this.db
        .prepare(
          `
          UPDATE workflow_graphs
          SET title = @title,
              graph_json = @graphJson,
              revision = @revision,
              updated_at = @updatedAt
          WHERE id = @graphId AND revision = @baseRevision
        `,
        )
        .run({
          graphId,
          title: updatedGraph.title,
          graphJson: serializeJson(updatedGraph),
          revision: updatedGraph.revision,
          updatedAt: updatedGraph.updatedAt,
          baseRevision: patch.baseRevision,
        });
      if (updateResult.changes !== 1) {
        throw new Error(`Workflow patch is stale: graph ${graphId} was updated before the patch could be saved.`);
      }

      const insertResult = this.db
        .prepare(
          `
          INSERT INTO workflow_patches (
            graph_id,
            project_id,
            orchestration_id,
            base_revision,
            resulting_revision,
            patch_json,
            source,
            reason,
            created_at
          )
          VALUES (
            @graphId,
            @projectId,
            @orchestrationId,
            @baseRevision,
            @resultingRevision,
            @patchJson,
            @source,
            @reason,
            @createdAt
          )
        `,
        )
        .run({
          graphId,
          projectId: existing.projectId,
          orchestrationId: existing.orchestrationId,
          baseRevision: patch.baseRevision,
          resultingRevision: updatedGraph.revision,
          patchJson: serializeJson(patch),
          source: patch.author ?? "planner",
          reason: patch.reason,
          createdAt: patch.createdAt,
        });
      return Number(insertResult.lastInsertRowid);
    });

    const patchId = tx();
    const row = this.db.prepare("SELECT * FROM workflow_patches WHERE id = ?").get(patchId) as WorkflowPatchRow | undefined;
    if (!row) {
      throw new Error("Workflow patch could not be loaded after insert.");
    }
    return mapPatchRow(row);
  }

  listPatches(graphId: number): PersistedWorkflowPatch[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM workflow_patches
        WHERE graph_id = ?
        ORDER BY resulting_revision ASC, id ASC
      `,
      )
      .all(graphId) as WorkflowPatchRow[];
    return rows.map(mapPatchRow);
  }

  getGraphSnapshot(graphId: number): PersistedWorkflowGraph | null {
    const row = this.db.prepare("SELECT * FROM workflow_graphs WHERE id = ?").get(graphId) as WorkflowGraphRow | undefined;
    return row ? mapGraphRow(row) : null;
  }
}

function mapGraphRow(row: WorkflowGraphRow): PersistedWorkflowGraph {
  const graph = parseGraphJson(row.graph_json, row.id);
  if (graph.revision !== row.revision) {
    throw new Error(`Workflow graph ${row.id} revision mismatch: row has ${row.revision}, graph_json has ${graph.revision}.`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    orchestrationId: row.orchestration_id,
    title: row.title,
    graph,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPatchRow(row: WorkflowPatchRow): PersistedWorkflowPatch {
  const patch = parsePatchJson(row.patch_json, row.id);
  return {
    id: row.id,
    graphId: row.graph_id,
    projectId: row.project_id,
    orchestrationId: row.orchestration_id,
    baseRevision: row.base_revision,
    resultingRevision: row.resulting_revision,
    patch,
    source: row.source,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function parseGraphJson(value: string, rowId: number): WorkflowGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Workflow graph ${rowId} has invalid graph_json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = validateWorkflowGraph(parsed);
  if (!result.ok || !result.value) {
    throw new Error(`Workflow graph ${rowId} failed validation: ${result.errors.join("; ")}`);
  }
  return result.value;
}

function parsePatchJson(value: string, rowId: number): WorkflowPatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Workflow patch ${rowId} has invalid patch_json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = validateWorkflowPatch(parsed);
  if (!result.ok || !result.value) {
    throw new Error(`Workflow patch ${rowId} failed validation: ${result.errors.join("; ")}`);
  }
  return result.value;
}

function assertValidGraph(graph: WorkflowGraph): void {
  const result = validateWorkflowGraph(graph);
  if (!result.ok) {
    throw new Error(`Workflow graph is invalid: ${result.errors.join("; ")}`);
  }
}

function requireGraph(graph: PersistedWorkflowGraph | null, id: number): PersistedWorkflowGraph {
  if (!graph) {
    throw new Error(`Workflow graph ${id} not found.`);
  }
  return graph;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
