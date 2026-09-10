// apps/api/src/services/space-roles.ts

export async function deleteSpaceRole(roleId: string): Promise<void> {
  try {
    await db.transaction(async (trx) => {
      // Re-verify assignment count with pessimistic locking inside transaction
      const assignments = await trx
        .select()
        .from(spaceMembers)
        .where(eq(spaceMembers.customRoleId, roleId))
        .for('update');

      if (assignments.length > 0) {
        throw new HttpError(409, 'role_in_use', 'Cannot delete role with active assignments');
      }

      await trx
        .delete(spaceRoles)
        .where(eq(spaceRoles.id, roleId));
    });
  } catch (error: any) {
    // Handle Postgres foreign key violation (23503) from concurrent assignments
    if (error?.code === '23503' || error?.status === 409) {
      throw new HttpError(409, 'role_in_use', 'Cannot delete role with active assignments');
    }
    throw error;
  }
}