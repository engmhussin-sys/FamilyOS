import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CHILDREN_QUERY_KEY, childrenApi } from '../../children/api/childrenApi';
import { screenTimeApi, screenTimePolicyQueryKey } from '../api/screenTimeApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';

function ChildPolicyRow({ childId, childFirstName }: { childId: string; childFirstName: string }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: policy, isLoading } = useQuery({
    queryKey: screenTimePolicyQueryKey(childId),
    queryFn: () => screenTimeApi.getPolicy(childId),
  });

  const [dailyLimit, setDailyLimit] = useState('');
  const [bedtimeStart, setBedtimeStart] = useState('');
  const [bedtimeEnd, setBedtimeEnd] = useState('');
  const [focusMode, setFocusMode] = useState(false);

  function startEditing() {
    setDailyLimit(policy?.dailyLimitMinutes?.toString() ?? '');
    setBedtimeStart(policy?.bedtimeStart ?? '');
    setBedtimeEnd(policy?.bedtimeEnd ?? '');
    setFocusMode(policy?.focusModeEnabled ?? false);
    setError(null);
    setIsEditing(true);
  }

  async function save() {
    setIsSaving(true);
    setError(null);
    try {
      await screenTimeApi.setPolicy(childId, {
        dailyLimitMinutes: dailyLimit ? Number(dailyLimit) : undefined,
        bedtimeStart: bedtimeStart || undefined,
        bedtimeEnd: bedtimeEnd || undefined,
        focusModeEnabled: focusMode,
      });
      await queryClient.invalidateQueries({ queryKey: screenTimePolicyQueryKey(childId) });
      setIsEditing(false);
    } catch {
      setError('تعذّر حفظ السياسة. تأكد من صحة القيم المدخلة.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="rounded-card border border-sand-200 px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="font-medium text-ink">{childFirstName}</p>
        {!isEditing && (
          <Button variant="ghost" onClick={startEditing}>
            {policy ? 'تعديل' : 'ضبط سياسة'}
          </Button>
        )}
      </div>

      {!isEditing && !isLoading && (
        <p className="mt-1 text-xs text-ink-soft">
          {policy
            ? `الحد اليومي: ${policy.dailyLimitMinutes ?? 'غير محدد'} دقيقة`
            : 'لا توجد سياسة مضبوطة بعد.'}
        </p>
      )}

      {isEditing && (
        <div className="mt-3 flex flex-col gap-3">
          <Input
            label="الحد اليومي (بالدقائق)"
            type="number"
            min={0}
            max={1440}
            value={dailyLimit}
            onChange={(e) => setDailyLimit(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="بداية وقت النوم"
              type="time"
              value={bedtimeStart}
              onChange={(e) => setBedtimeStart(e.target.value)}
            />
            <Input
              label="نهاية وقت النوم"
              type="time"
              value={bedtimeEnd}
              onChange={(e) => setBedtimeEnd(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={focusMode}
              onChange={(e) => setFocusMode(e.target.checked)}
            />
            تفعيل وضع التركيز
          </label>

          {error && <p className="text-xs text-brick-600">{error}</p>}

          <div className="flex gap-2">
            <Button onClick={save} isLoading={isSaving}>
              حفظ
            </Button>
            <Button variant="ghost" onClick={() => setIsEditing(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ScreenTimePolicyCard() {
  const { data: children, isLoading, isError } = useQuery({
    queryKey: CHILDREN_QUERY_KEY,
    queryFn: childrenApi.list,
  });

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">وقت الشاشة</h2>
      <div className="mt-4 flex flex-col gap-3">
        {isLoading && <p className="text-sm text-ink-soft">جارٍ التحميل...</p>}
        {isError && <p className="text-sm text-brick-600">تعذّر تحميل قائمة الأطفال.</p>}
        {children?.length === 0 && (
          <p className="text-sm text-ink-soft">أضف طفلًا أولًا لضبط سياسة وقت الشاشة.</p>
        )}
        {children?.map((child) => (
          <ChildPolicyRow key={child.id} childId={child.id} childFirstName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
