import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { childrenApi, CHILDREN_QUERY_KEY } from '../api/childrenApi';
import { Input } from '../../../shared/components/Input';
import { Button } from '../../../shared/components/Button';

export function AddChildForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');

  const mutation = useMutation({
    mutationFn: () => childrenApi.create({ firstName, dateOfBirth }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CHILDREN_QUERY_KEY });
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-card bg-sage-100 p-4">
      <Input
        label="اسم الطفل"
        required
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />
      <Input
        label="تاريخ الميلاد"
        type="date"
        required
        max={new Date().toISOString().split('T')[0]}
        value={dateOfBirth}
        onChange={(e) => setDateOfBirth(e.target.value)}
      />
      {mutation.isError && (
        <p role="alert" className="text-sm text-brick-600">
          {mutation.error instanceof Error ? mutation.error.message : 'تعذّر إضافة الطفل.'}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" isLoading={mutation.isPending}>
          إضافة
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          إلغاء
        </Button>
      </div>
    </form>
  );
}
