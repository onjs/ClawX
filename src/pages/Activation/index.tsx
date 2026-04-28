import { FormEvent, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TitleBar } from '@/components/layout/TitleBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLicenseStore } from '@/stores/license';

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function Activation() {
  const { t } = useTranslation('setup');
  const [code, setCode] = useState('');
  const { activating, error, activate, clearError } = useLicenseStore();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearError();
    await activate(code);
  };

  return (
    <div data-testid="activation-page" className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-xl rounded-2xl border bg-card p-8 shadow-sm">
          <h1 className="mb-6 text-3xl font-bold">{t('activation.title')}</h1>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <Input
              data-testid="activation-code-input"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t('activation.codePlaceholder')}
              autoFocus
            />
            <Button
              data-testid="activation-submit-button"
              type="submit"
              disabled={activating || code.trim().length === 0}
              className="w-full"
            >
              {activating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('activation.validating')}
                </>
              ) : t('activation.submit')}
            </Button>
          </form>

          {error && error !== 'Activation record not found.' && (
            <p data-testid="activation-error" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default Activation;
