'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPost } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';

export function CreateProjectDialog({ trigger }: { trigger?: React.ReactNode }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => apiPost<{ id: string }>('/api/projects', { name, description: description.trim() ? description : null, providerType: 'fpt_marketplace' }),
    onSuccess: (p) => {
      toast.success(t.projects.created);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
      router.push(`/projects/${p.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : t.common.genericError);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setErrors({});
          setName('');
          setDescription('');
        }
      }}
    >
      <DialogTrigger asChild>{trigger ?? <Button>{t.projects.create}</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.projects.createTitle}</DialogTitle>
          <DialogDescription>{t.projects.subtitle}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-name">{t.projects.name}</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus required />
            {errors.name ? <p className="text-sm text-destructive">{errors.name}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-desc">{t.projects.description}</Label>
            <Textarea id="project-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} placeholder={t.projects.descriptionPlaceholder} />
            {errors.description ? <p className="text-sm text-destructive">{errors.description}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? t.common.loading : t.projects.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
