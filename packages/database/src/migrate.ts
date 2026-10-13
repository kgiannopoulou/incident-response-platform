import { createPool, MIGRATIONS_DIR, runMigrations } from "./index";

const pool = createPool();
runMigrations(pool, MIGRATIONS_DIR)
  .then(() => console.log("Migrations complete."))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
