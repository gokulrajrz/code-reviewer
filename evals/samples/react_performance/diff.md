## 🔍 FILE CHANGED: `src/components/Dashboard.tsx` (modified) — *Full Review*
### DIFF PATCH
```diff
 import React from 'react';
 import { useAppStore } from '../stores/appStore';
 
 export const Dashboard: React.FC = () => {
-  const user = useAppStore(state => state.user);
+  const store = useAppStore();
 
   return (
     <div>
-      <UserCard user={user} />
+      <UserCard user={store.user} />
+      <DataTable
+        config={{ pageSize: 10, sortBy: 'name', order: 'asc' }}
+        data={store.tableData}
+      />
     </div>
   );
 };
```
