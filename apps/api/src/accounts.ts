import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
}
export interface AccountSession {
  user: AccountUser;
  deviceId: string;
  token: string;
  expiresAt: string;
}
export class AccountError extends Error {}
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 65536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
const emailKey = (email: string) => email.trim().toLowerCase();
export class AccountStore {
  private db: DatabaseSync;
  private ownsDatabase: boolean;
  constructor(path: string | DatabaseSync) {
    this.ownsDatabase = typeof path === "string";
    this.db = typeof path === "string" ? new DatabaseSync(path) : path;
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS account_users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,device_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_deleted_users(id TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS account_session_user ON account_sessions(user_id,device_id);`);
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(account_users)")
        .all()
        .map((row) => String(row.name)),
    );
    for (const [name, definition] of Object.entries({
      disabled: "INTEGER NOT NULL DEFAULT 0",
      created_at: "TEXT",
      last_login_at: "TEXT",
    })) {
      if (!columns.has(name))
        this.db.exec(
          `ALTER TABLE account_users ADD COLUMN ${name} ${definition}`,
        );
    }
  }
  close() {
    if (this.ownsDatabase) this.db.close();
  }
  async register(
    email: string,
    password: string,
    displayName: string,
    deviceId: string,
  ): Promise<AccountSession> {
    const normalized = emailKey(email);
    const salt = randomBytes(32).toString("hex");
    const hash = await derive(password, salt);
    const user = {
      id: randomUUID(),
      email: normalized,
      displayName: displayName.trim(),
    };
    // Check after hashing too: concurrent registrations cannot overwrite the unique account.
    if (
      this.db
        .prepare("SELECT id FROM account_users WHERE email=?")
        .get(normalized)
    )
      throw new AccountError("EMAIL_EXISTS");
    this.db
      .prepare(
        "INSERT INTO account_users(id,email,display_name,salt,password_hash,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        user.id,
        user.email,
        user.displayName,
        salt,
        hash.toString("hex"),
        new Date().toISOString(),
      );
    return this.session(user, deviceId);
  }
  async login(
    email: string,
    password: string,
    deviceId: string,
  ): Promise<AccountSession> {
    const row = this.db
      .prepare("SELECT * FROM account_users WHERE email=?")
      .get(emailKey(email));
    const hash = await derive(password, String(row?.salt ?? "0".repeat(64)));
    const expected = row
      ? Buffer.from(String(row.password_hash), "hex")
      : Buffer.alloc(64);
    if (!timingSafeEqual(hash, expected) || !row)
      throw new AccountError("INVALID_CREDENTIALS");
    // Password derivation yields: an administrator may disable the account meanwhile.
    if (this.isDisabled(String(row.id)))
      throw new AccountError("ACCOUNT_DISABLED");
    return this.session(
      {
        id: String(row.id),
        email: String(row.email),
        displayName: String(row.display_name),
      },
      deviceId,
    );
  }
  private session(user: AccountUser, deviceId: string): AccountSession {
    const updated = this.db
      .prepare("UPDATE account_users SET last_login_at=? WHERE id=?")
      .run(new Date().toISOString(), user.id);
    // Password hashing can finish after an administrator deletes the account.
    if (!updated.changes) throw new AccountError("INVALID_CREDENTIALS");
    const token = randomBytes(32).toString("hex"),
      expires = Date.now() + 30 * 86400000;
    this.db
      .prepare("DELETE FROM account_sessions WHERE expires_at<=?")
      .run(Date.now());
    this.db
      .prepare("INSERT INTO account_sessions VALUES(?,?,?,?)")
      .run(digest(token), user.id, deviceId, expires);
    return {
      user,
      deviceId,
      token,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  identify(token: string) {
    const row = this.db
      .prepare(
        "SELECT u.id,u.email,u.display_name,s.device_id,s.expires_at FROM account_sessions s JOIN account_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0",
      )
      .get(digest(token), Date.now());
    return row
      ? {
          ownerId: String(row.id),
          deviceId: String(row.device_id),
          tokenHash: digest(token),
          user: {
            id: String(row.id),
            email: String(row.email),
            displayName: String(row.display_name),
          },
          expiresAt: new Date(Number(row.expires_at)).toISOString(),
        }
      : undefined;
  }
  logout(token: string) {
    this.db
      .prepare("DELETE FROM account_sessions WHERE token_hash=?")
      .run(digest(token));
  }
  async changePassword(
    token: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const identity = this.identify(token);
    if (!identity) throw new AccountError("INVALID_CREDENTIALS");
    const row = this.db
      .prepare(
        "SELECT salt,password_hash,disabled FROM account_users WHERE id=?",
      )
      .get(identity.ownerId);
    const hash = await derive(
      currentPassword,
      String(row?.salt ?? "0".repeat(64)),
    );
    const expected = row
      ? Buffer.from(String(row.password_hash), "hex")
      : Buffer.alloc(64);
    if (
      !row ||
      expected.length !== hash.length ||
      !timingSafeEqual(hash, expected)
    )
      throw new AccountError("INVALID_CREDENTIALS");
    if (row.disabled === 1) throw new AccountError("ACCOUNT_DISABLED");
    if (currentPassword === newPassword)
      throw new AccountError("PASSWORD_UNCHANGED");
    const salt = randomBytes(32).toString("hex");
    const next = await derive(newPassword, salt);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE account_users SET salt=?,password_hash=? WHERE id=?")
        .run(salt, next.toString("hex"), identity.ownerId);
      this.db
        .prepare(
          "DELETE FROM account_sessions WHERE user_id=? AND token_hash<>?",
        )
        .run(identity.ownerId, digest(token));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  isDisabled(ownerId: string) {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM account_users WHERE id=? AND disabled=1 UNION ALL SELECT 1 FROM account_deleted_users WHERE id=? LIMIT 1",
        )
        .get(ownerId, ownerId) !== undefined
    );
  }
}
