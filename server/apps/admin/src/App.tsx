import { DirectionProvider } from '@radix-ui/react-direction';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { useI18n } from '@/i18n/useI18n';
import { queryClient } from '@/lib/queries';
import { routes } from './routes';

const router = createBrowserRouter(routes);

export function App() {
  const { dir } = useI18n();
  return (
    <QueryClientProvider client={queryClient}>
      <DirectionProvider dir={dir}>
        <RouterProvider router={router} />
      </DirectionProvider>
    </QueryClientProvider>
  );
}
