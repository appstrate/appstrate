import postgres from "postgres";

const databaseUrl =
  process.env.DATABASE_URL || "postgres://appstrate:appstrate@localhost:5432/appstrate";

const sql = postgres(databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export default sql;
