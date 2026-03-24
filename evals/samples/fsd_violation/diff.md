## 🔍 FILE CHANGED: `src/features/auth/ui/LoginForm.tsx` (modified) — *Full Review*
### DIFF PATCH
```diff
 import React from 'react';
+import { useProfileStore } from '../../profile/model/store';
 import { useAuthStore } from '../model/store';
 
 export const LoginForm: React.FC = () => {
   const { login, isLoading } = useAuthStore();
+  const { userPreferences } = useProfileStore();
 
   return (
     <form onSubmit={(e) => { e.preventDefault(); login(); }}>
+      <p>Theme: {userPreferences.theme}</p>
       <button disabled={isLoading}>Login</button>
     </form>
   );
 };
```
