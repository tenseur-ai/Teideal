import pg from "pg";
import { SUPERUSER_DATABASE_URL } from "./env.js";

export const superPool = new pg.Pool({ connectionString: SUPERUSER_DATABASE_URL });
