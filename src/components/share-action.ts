/** A balance read cannot undo a confirmed wallet action. Invalidate every display even
 * when a multi-step action throws after an earlier transaction was submitted. */
export async function settleShareAction(
  work: () => Promise<string>,
  invalidate: () => void,
  refresh: () => Promise<void>,
): Promise<{ confirmation: string | null; actionError: unknown; refreshError: unknown }> {
  let confirmation: string | null = null;
  let actionError: unknown = null;
  let refreshError: unknown = null;
  try {
    confirmation = await work();
  } catch (cause) {
    actionError = cause;
  } finally {
    try {
      invalidate();
    } finally {
      try {
        await refresh();
      } catch (cause) {
        refreshError = cause;
      }
    }
  }
  return { confirmation, actionError, refreshError };
}
