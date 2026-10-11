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
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS account_users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,device_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_session_user ON account_sessions(user_id,device_id);`);
  }
  close() {
    this.db.close();
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
      .prepare("INSERT INTO account_users VALUES(?,?,?,?,?)")
      .run(user.id, user.email, user.displayName, salt, hash.toString("hex"));
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
        "SELECT u.id,u.email,u.display_name,s.device_id,s.expires_at FROM account_sessions s JOIN account_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
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
}
