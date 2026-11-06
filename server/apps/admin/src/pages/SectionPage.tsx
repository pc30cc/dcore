import { Construction } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useI18n } from '@/i18n/useI18n';
import type { Section } from '@/lib/sections';

/** A section whose admin API is not built yet: says so. */
export function SectionPage({ section }: { section: Section }) {
  const { t } = useI18n();
  const Icon = section.icon;
  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
        <Icon className="size-6 text-primary" aria-hidden="true" />
        {t(section.label)}
      </h1>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Construction className="size-4" aria-hidden="true" />
            {t('section.pending.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {t('section.pending.body', { section: section.spec })}
        </CardContent>
      </Card>
    </div>
  );
}
