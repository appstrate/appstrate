import sql from "../apps/api/src/db/client.ts";

const schema = await Bun.file(
  new URL("../apps/api/src/db/schema.sql", import.meta.url).pathname,
).text();

console.log("Setting up database schema...");
await sql.unsafe(schema);
console.log("Database schema created successfully.");

await sql.end();
