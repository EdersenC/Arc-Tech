import fs from "node:fs";

export function dropSudoPrivilegesForLocalServer(): void {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof process.setuid !== "function" ||
    typeof process.setgid !== "function" ||
    process.getuid() !== 0
  ) {
    return;
  }

  const target = sudoTargetUser();
  if (!target) {
    console.warn("Running as root without SUDO_UID/SUDO_GID; generated task workspaces may not be accessible to Codex.");
    return;
  }

  process.env.HOME = target.home;
  process.env.USER = target.user;
  process.env.LOGNAME = target.user;

  process.setgid(target.gid);
  process.setuid(target.uid);
  console.warn(`Dropped sudo privileges to ${target.user} (${target.uid}:${target.gid}).`);
}

function sudoTargetUser(): { user: string; uid: number; gid: number; home: string } | null {
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  const user = process.env.SUDO_USER;
  if (!user || !Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) {
    return null;
  }

  return { user, uid, gid, home: homeForUser(user) ?? `/home/${user}` };
}

function homeForUser(user: string): string | null {
  let passwd: string;
  try {
    passwd = fs.readFileSync("/etc/passwd", "utf8");
  } catch {
    return null;
  }

  for (const line of passwd.split(/\r?\n/)) {
    const fields = line.split(":");
    if (fields[0] === user && fields[5]) {
      return fields[5];
    }
  }
  return null;
}
