const DEFAULT_DISCORD_MESSAGE_LIMIT = 1900;

type Segment = { kind: "text" | "code"; text: string };

export function splitDiscordContent(text: string, maxLength = DEFAULT_DISCORD_MESSAGE_LIMIT): string[] {
  const source = String(text ?? "");
  if (source.length <= maxLength) {
    return [source];
  }

  const segments = splitByCodeSegments(source);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const segment of segments) {
    const pieces = segment.kind === "code" ? splitCodeBlockSegment(segment.text, maxLength) : splitTextSegment(segment.text, maxLength);

    for (const piece of pieces) {
      if (!piece) {
        continue;
      }

      if (piece.length > maxLength) {
        const hardPieces = hardSplit(piece, maxLength);
        for (const hardPiece of hardPieces) {
          if (!hardPiece) {
            continue;
          }
          if (hardPiece.length + currentChunk.length > maxLength && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = "";
          }
          if (hardPiece.length > maxLength) {
            chunks.push(hardPiece.slice(0, maxLength));
            continue;
          }

          currentChunk = currentChunk ? `${currentChunk}${hardPiece}` : hardPiece;
          if (currentChunk.length >= maxLength) {
            chunks.push(currentChunk);
            currentChunk = "";
          }
        }
        continue;
      }

      if (piece.length + currentChunk.length > maxLength && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = piece;
      } else {
        currentChunk = currentChunk ? `${currentChunk}${piece}` : piece;
      }

      if (currentChunk.length >= maxLength) {
        chunks.push(currentChunk);
        currentChunk = "";
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length ? chunks : [""];
}

function splitByCodeSegments(value: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /```[\s\S]*?```/g;
  let cursor = 0;
  let match = regex.exec(value);

  while (match) {
    if (match.index > cursor) {
      segments.push({ kind: "text", text: value.slice(cursor, match.index) });
    }
    segments.push({ kind: "code", text: match[0] });
    cursor = match.index + match[0].length;
    match = regex.exec(value);
  }

  if (cursor < value.length) {
    segments.push({ kind: "text", text: value.slice(cursor) });
  }

  return segments;
}

function splitCodeBlockSegment(value: string, maxLength: number): string[] {
  const openEnd = value.indexOf("\n");
  const closeStart = value.lastIndexOf("```");
  if (openEnd < 0 || closeStart < 0 || closeStart <= openEnd) {
    return splitTextSegment(value, maxLength);
  }

  const opening = value.slice(0, openEnd + 1);
  const closing = value.slice(closeStart);
  const body = value.slice(openEnd + 1, closeStart);

  const overhead = opening.length + closing.length;
  if (overhead >= maxLength) {
    return [value];
  }
  if (value.length <= maxLength) {
    return [value];
  }

  const bodyLimit = maxLength - overhead;
  if (bodyLimit <= 0) {
    return [value];
  }

  const bodyChunks = hardSplit(body, bodyLimit);
  if (bodyChunks.length === 0) {
    return [`${opening}${closing}`];
  }

  return bodyChunks.map((bodyChunk) => `${opening}${bodyChunk}${closing}`);
}

function splitTextSegment(value: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const pieces = value.split(/(\r?\n)/);

  for (const piece of pieces) {
    if (!piece) {
      continue;
    }

    if (piece.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardSplit(piece, maxLength));
      continue;
    }

    if (current.length + piece.length <= maxLength) {
      current += piece;
      continue;
    }

    if (current.length) {
      chunks.push(current);
    }
    current = piece;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length ? chunks : [""];
}

function hardSplit(value: string, maxLength: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += maxLength) {
    chunks.push(value.slice(i, i + maxLength));
  }
  return chunks;
}
