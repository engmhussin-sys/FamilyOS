import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { pairingApi } from '../api/pairingApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Button } from '../../../shared/components/Button';
import { Card } from '../../../shared/components/Card';
import { GuardianRing } from '../../../shared/components/GuardianRing';

export function PairingCard() {
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  const [childId, setChildId] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Once children load, default the selector to the first one so the
  // dashboard is usable in one click for the common single-child case.
  useEffect(() => {
    if (children && children.length > 0 && !childId) {
      setChildId(children[0].id);
    }
  }, [children, childId]);

  const mutation = useMutation({
    mutationFn: () => pairingApi.initiate(childId),
    onSuccess: (result) => setSecondsLeft(result.expiresInSeconds),
  });

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  const code = mutation.data?.code;
  const totalSeconds = mutation.data?.expiresInSeconds ?? 1;
  const isExpired = code !== undefined && secondsLeft === 0;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">إقران جهاز الطفل</h2>
      <p className="mt-1 text-sm text-ink-soft">
        اطلب رمزًا واكتبه في تطبيق الطفل لإقران الجهاز بالعائلة.
      </p>

      {!children || children.length === 0 ? (
        <p className="mt-4 rounded-card bg-sand-100 px-4 py-3 text-sm text-ink-soft">
          أضف طفلاً أولاً من بطاقة "الأطفال" فوق قبل إقران جهاز.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-col gap-1.5">
            <label htmlFor="pairing-child-select" className="text-sm font-medium text-ink">
              الطفل
            </label>
            <select
              id="pairing-child-select"
              value={childId}
              onChange={(e) => setChildId(e.target.value)}
              className="rounded-card border border-sand-200 bg-white px-3.5 py-2.5 text-sm text-ink focus:border-sage-500"
            >
              {children.map((child) => (
                <option key={child.id} value={child.id}>
                  {child.firstName}
                </option>
              ))}
            </select>
          </div>

          {!code || isExpired ? (
            <Button
              className="mt-4"
              variant="secondary"
              isLoading={mutation.isPending}
              disabled={!childId}
              onClick={() => mutation.mutate()}
            >
              إنشاء رمز إقران
            </Button>
          ) : (
            <div className="mt-4 flex items-center gap-4 rounded-card bg-sage-100 p-4">
              <GuardianRing
                progressPercent={(secondsLeft / totalSeconds) * 100}
                size={44}
                className="shrink-0 text-sage-600"
              />
              <div>
                <p className="font-mono text-xl font-medium tracking-wider text-guardian-900">
                  {code}
                </p>
                <p className="text-xs text-ink-soft">
                  صالح لمدة {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {mutation.isError && (
        <p role="alert" className="mt-3 text-sm text-brick-600">
          {mutation.error instanceof Error ? mutation.error.message : 'تعذّر إنشاء رمز الإقران.'}
        </p>
      )}
    </Card>
  );
}
