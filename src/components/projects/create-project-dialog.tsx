'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPost } from '@/lib/api-client';
import { useProviders } from '@/lib/hooks/use-providers';
import { vi } from '@/lib/i18n/vi';

export function CreateProjectDialog({ trigger }: { trigger?: React.ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const providers = useProviders();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [providerType, setProviderType] = useState<string>('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Mặc định chọn nhà cung cấp khả dụng đầu tiên (không dùng effect: suy ra khi render)
  const list = providers.data ?? [];
  const effectiveType = providerType || (list.find((p) => p.available) ?? list[0])?.type || '';

  const create = useMutation({
    mutationFn: () => apiPost<{ id: string }>('/api/projects', { name, description: description.trim() ? description : null, providerType: effectiveType }),
    onSuccess: (p) => {
      toast.success(vi.projects.created);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
      router.push(`/projects/${p.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : vi.common.genericError);
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
          setProviderType('');
        }
      }}
    >
      <DialogTrigger asChild>{trigger ?? <Button>{vi.projects.create}</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{vi.projects.createTitle}</DialogTitle>
          <DialogDescription>{vi.projects.subtitle}</DialogDescription>
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
            <Label htmlFor="project-name">{vi.projects.name}</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus required />
            {errors.name ? <p className="text-sm text-destructive">{errors.name}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-desc">{vi.projects.description}</Label>
            <Textarea id="project-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} placeholder={vi.projects.descriptionPlaceholder} />
            {errors.description ? <p className="text-sm text-destructive">{errors.description}</p> : null}
          </div>
          <div className="space-y-2">
            <Label>{vi.projects.provider}</Label>
            <Select value={effectiveType} onValueChange={setProviderType}>
              <SelectTrigger aria-label={vi.projects.provider}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.map((p) => (
                  <SelectItem key={p.type} value={p.type}>
                    {p.label}
                    {!p.available ? ` (${vi.projects.providerUnavailable})` : p.usingOwnConfig ? ` (${vi.projects.providerOwn})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.providerType ? <p className="text-sm text-destructive">{errors.providerType}</p> : null}
            {list.length > 0 && list.find((p) => p.type === effectiveType)?.available === false ? (
              <p className="text-xs text-muted-foreground">{vi.projects.noProviderTip}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {vi.common.cancel}
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim() || !effectiveType}>
              {create.isPending ? vi.common.loading : vi.projects.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
