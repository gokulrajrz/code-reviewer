## 🔍 FILE CHANGED: `src/db/queries.ts` (added) — *Full Review*
### DIFF PATCH
```diff
+import { db } from '../config/database';
+
+export async function getUserByEmail(email: string) {
+  const query = `SELECT * FROM users WHERE email = '${email}'`;
+  const result = await db.execute(query);
+  return result.rows[0];
+}
+
+export async function searchUsers(searchTerm: string) {
+  const query = `SELECT * FROM users WHERE name LIKE '%${searchTerm}%' ORDER BY created_at DESC`;
+  return await db.execute(query);
+}
```
