import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { childrenApi, CHILDREN_QUERY_KEY } from '../api/childrenApi';
import { calculateAge } from '../../../shared/lib/age';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { AddChildForm } from './AddChildForm';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

export function ChildrenListCard() {
  const [isAdding, setIsAdding] = useState(false);
  const { t } = useTranslation();
  const { data: children, isLoading, isError } = useQuery({
    queryKey: CHILDREN_QUERY_KEY,
    queryFn: childrenApi.list,
  });

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-ink">{t('children.title')}</h2>
        {!isAdding && (
          <Button variant="secondary" onClick={() => setIsAdding(true)}>
            {t('children.addChild')}
          </Button>
        )}
      </div>

      {isAdding && (
        <div className="mt-4">
          <AddChildForm onDone={() => setIsAdding(false)} />
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {isLoading && <p className="text-sm text-ink-soft">{t('common.loading')}</p>}
        {isError && <p className="text-sm text-brick-600">{t('common.error')}</p>}
        {children?.length === 0 && !isAdding && (
          <p className="text-sm text-ink-soft">{t('children.empty')}</p>
        )}
        {children?.map((child) => (
          <div
            key={child.id}
            className="flex items-center gap-3 rounded-card border border-sand-200 px-4 py-3"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-guardian-900 font-display text-sm text-sand-50">
              {child.firstName.charAt(0)}
            </span>
            <div>
              <p className="font-medium text-ink">{child.firstName}</p>
              <p className="text-xs text-ink-soft">
                {t('children.yearsOld', { age: calculateAge(child.dateOfBirth) })}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
