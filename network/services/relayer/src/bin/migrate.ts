import { createPool, migrate } from "../db.js";
import { createLogger } from "../log.js";

const log = createLogger({ service: "lattice-migrate" });
const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL is required");
  process.exit(2);
}
const pool = createPool(url);
try {
  const applied = await migrate(pool);
  log.info("migrations applied", { applied });
} finally {
  await pool.end();
}
