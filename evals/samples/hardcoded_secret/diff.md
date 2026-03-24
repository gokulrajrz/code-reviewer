## 🔍 FILE CHANGED: `src/config/api.ts` (added) — *Full Review*
### DIFF PATCH
```diff
+const API_KEY = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234';
+const STRIPE_SECRET = 'sk_test_51HG3k2CjOa3R4x5y6z7w8v9u0t1s2r3q4p5o6n7m8l9k0j';
+
+export const apiClient = {
+  baseUrl: 'https://api.example.com',
+  headers: {
+    'Authorization': `Bearer ${API_KEY}`,
+    'X-Stripe-Key': STRIPE_SECRET,
+  },
+};
+
+export async function fetchData(endpoint: string) {
+  const response = await fetch(`${apiClient.baseUrl}/${endpoint}`, {
+    headers: apiClient.headers,
+  });
+  return response.json();
+}
```
