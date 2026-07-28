import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { childrenApi, CHILDREN_QUERY_KEY } from '../api/childrenApi';
import { calculateAge } from '../../../shared/lib/age';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { AddChildForm } from './AddChildForm';

export function ChildrenListCard() {
  const [isAdding, setIsAdding] = useState(false);
  const { data: children, isLoading, isError } = useQuery({
    queryKey: CHILDREN_QUERY_KEY,
    queryFn: childrenApi.list,
  });

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-ink">الأطفال</h2>
        {!isAdding && (
          <Button variant="secondary" onClick={() => setIsAdding(true)}>
            + إضافة طفل
          </Button>
        )}
      </div>

      {isAdding && (
        <div className="mt-4">
          <AddChildForm onDone={() => setIsAdding(false)} />
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {isLoading && <p className="text-sm text-ink-soft">جارٍ التحميل...</p>}
        {isError && <p className="text-sm text-brick-600">تعذّر تحميل قائمة الأطفال.</p>}
        {children?.length === 0 && !isAdding && (
          <p className="text-sm text-ink-soft">لا يوجد أطفال بعد. أضف أول طفل للبدء.</p>
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
              <p className="text-xs text-ink-soft">{calculateAge(child.dateOfBirth)} سنة</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
