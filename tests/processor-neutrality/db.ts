import pg from "pg";
import { pool, withTenant } from "../stripe-connect/db.js";

export { pool, withTenant };

export const SUPERUSER_DATABASE_URL = process.env.SUPERUSER_DATABASE_URL
  ?? "postgres://postgres:postgres@127.0.0.1:5432/teideal";

export const superPool = new pg.Pool({ connectionString: SUPERUSER_DATABASE_URL });
