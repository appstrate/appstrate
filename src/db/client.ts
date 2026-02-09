import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL || "postgres://openflows:openflows@localhost:5432/openflows";

const sql = postgres(databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export default sql;
