import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAdmin } from '@/components/layout/RequireAdmin';
import { sections } from '@/lib/sections';
import { HostsPage } from '@/pages/HostsPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SectionPage } from '@/pages/SectionPage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAdmin>
        <AppShell />
      </RequireAdmin>
    ),
    children: [
      ...sections.map((section) =>
        section.path === ''
          ? { index: true, element: <SectionPage section={section} /> }
          : { path: section.path, element: section.path === 'hosts' ? <HostsPage /> : <SectionPage section={section} /> },
      ),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
