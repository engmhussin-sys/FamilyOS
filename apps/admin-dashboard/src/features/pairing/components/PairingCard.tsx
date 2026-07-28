import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { pairingApi } from '../api/pairingApi';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { Card } from '../../../shared/components/Card';
import { GuardianRing } from '../../../shared/components/GuardianRing';

export function PairingCard() {
  const [childId, setChildId] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);

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

      {/* TODO(follow-up): استبدل هذا الحقل بقائمة اختيار للطفل بمجرد توفر
          واجهة برمجية لإدارة الأطفال (ChildrenModule) — هذا حل مؤقت موثّق،
          وليس تسوية صامتة. */}
      <div className="mt-4">
        <Input
          label="معرّف الطفل (Child ID) — مؤقت"
          hint="سيصبح قائمة اختيار عند توفر إدارة الأطفال"
          value={childId}
          onChange={(e) => setChildId(e.target.value)}
        />
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
            <p className="font-mono text-xl font-medium tracking-wider text-guardian-900">{code}</p>
            <p className="text-xs text-ink-soft">
              صالح لمدة {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </p>
          </div>
        </div>
      )}

      {mutation.isError && (
        <p role="alert" className="mt-3 text-sm text-brick-600">
          {mutation.error instanceof Error ? mutation.error.message : 'تعذّر إنشاء رمز الإقران.'}
        </p>
      )}
    </Card>
  );
}
