import { auth as _auth } from "@appstrate/db/auth";
export { auth } from "@appstrate/db/auth";

/** Hash a password using Better Auth's internal hasher (salt:hex format). */
export async function hashPassword(password: string): Promise<string> {
  const ctx = await _auth.$context;
  return ctx.password.hash(password);
}
