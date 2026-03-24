## 🔍 FILE CHANGED: `src/utils/format.ts` (added) — *Full Review*
### DIFF PATCH
```diff
+/**
+ * Formats a date string into a human-readable format.
+ */
+export function formatDate(date: Date): string {
+  return new Intl.DateTimeFormat('en-US', {
+    year: 'numeric',
+    month: 'long',
+    day: 'numeric',
+  }).format(date);
+}
+
+/**
+ * Formats a number as currency.
+ */
+export function formatCurrency(amount: number, currency = 'USD'): string {
+  return new Intl.NumberFormat('en-US', {
+    style: 'currency',
+    currency,
+  }).format(amount);
+}
+
+/**
+ * Truncates a string to a maximum length with ellipsis.
+ */
+export function truncate(str: string, maxLength: number): string {
+  if (str.length <= maxLength) return str;
+  return `${str.slice(0, maxLength - 3)}...`;
+}
```
