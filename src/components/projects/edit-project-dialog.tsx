'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPatch } from '@/lib/api-client';
import { useProviders } from '@/lib/hooks/use-providers';
import { useT } from '@/lib/i18n/client';

type Editable = { id: string; name: string; description: string | null; providerType: string };

/** Sửa tên, mô tả và nhà cung cấp mặc định của Project (FR-003). Đóng/mở lại thì nạp lại giá trị hiện tại (qua `key`). */
export function EditProjectDialog({ project, onClose }: { project: Editable | null; onClose: () => void }) {
  return project ? <EditForm key={project.id} project={project} onClose={onClose} /> : null;
}

function EditForm({ project, onClose }: { project: Editable; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const providers = useProviders();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const initialType = project.providerType === 'shopaikey_openai' ? 'shopaikey_minimax' : project.providerType;
  const [providerType, setProviderType] = useState(initialType);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => apiPatch(`/api/projects/${project.id}`, { name, description: description.trim() ? description : null, providerType }),
    onSuccess: () => {
      toast.success(t.projects.saved);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['project', project.id] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : t.common.genericError);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.projects.editTitle}</DialogTitle>
          <DialogDescription>{project.name}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="edit-name">{t.projects.name}</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
            {errors.name ? <p className="text-sm text-destructive">{errors.name}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-desc">{t.projects.description}</Label>
            <Textarea id="edit-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
            {errors.description ? <p className="text-sm text-destructive">{errors.description}</p> : null}
          </div>
          <div className="space-y-2">
            <Label>{t.projects.provider}</Label>
            <Select value={providerType} onValueChange={setProviderType}>
              <SelectTrigger aria-label={t.projects.provider}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(providers.data ?? []).map((p) => (
                  <SelectItem key={p.type} value={p.type}>
                    {p.label}
                    {!p.available ? ` (${t.projects.providerUnavailable})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending ? t.common.loading : t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
