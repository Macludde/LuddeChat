import { useCallback, useEffect, useState } from 'react';
import { useToastContext } from '~/Providers';
import { NotificationSeverity } from '~/common';
import
{
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '~/components/ui';
import { useAuthContext } from '~/hooks';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance: number;
};
const updateKrToCred = async (token) => {
  const exchangeRate = await fetch('/api/balance/exchange', {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  }).then((res) => res.text());
  return Number.parseInt(exchangeRate);
};

function SwishModal({ open, onOpenChange, currentBalance }: Props) {
  const { token } = useAuthContext();
  const [krToCred, setKrToCred] = useState(1000000 / 10);
  const [rawText, setRawText] = useState('10');
  const [paymentButtonLoading, setPaymentButtonLoading] = useState(false);
  const { showToast } = useToastContext();
  const amount = (() => {
    const parsed = parseFloat(rawText);
    return isNaN(parsed) ? 0 : parsed;
  })();

  useEffect(() => {
    updateKrToCred(token).then(setKrToCred);
  }, [token]);

  const onPayment = useCallback(async () => {
    setPaymentButtonLoading(true);
    try {
      const res = await fetch('/api/balance/payment', {
        method: 'POST',
        body: JSON.stringify({ amount }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      console.log(res);
      if (res.ok) {
        showToast({
          severity: NotificationSeverity.SUCCESS,
          status: 'success',
          message: 'Balans uppdaterad!',
        });
      } else {
        throw new Error('Failed to update balance');
      }
    } catch (err) {
      showToast({
        severity: NotificationSeverity.ERROR,
        status: 'error',
        message:
          'Kunde inte uppdatera balansen, försök igen om en liten stund (du behöver inte swisha igen).',
      });
    }
    setPaymentButtonLoading(false);
  }, [amount, token, showToast]);

  const swishUrl = `https://app.swish.nu/1/p/sw/?sw=0762774322&amt=${Math.floor(
    amount,
  )}&cur=SEK&msg=LuddeChat%20Kredit&src=qr`;
  const qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data="${encodeURIComponent(
    swishUrl,
  )}"`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Balans</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-start gap-4 p-8">
          <p className="text-black dark:text-white">
            Du har {currentBalance.toLocaleString()} krediter.
            <br />
            Detta motsvarar {(currentBalance / krToCred).toLocaleString()} kr.
          </p>
          <div className="flex items-center gap-2">
            <Label>Kronor</Label>
            <Input type="number" value={rawText} onChange={(e) => setRawText(e.target.value)} />
          </div>
          <p className="text-black dark:text-white">
            {amount}kr kommer ge dig {(amount * krToCred).toLocaleString()} kredit (balance).
            <br />
            <br />
            Detta är utifrån valutakursen till USD samt priset av OpenAIs modeller. Krediterna du
            får, och kostnaden av dem går till 100% för att betala OpenAI, jag tar ingen
            mellanskillnad eller vinst.
          </p>
          <p className="text-lg font-semibold text-black dark:text-white">
            Skanna qr koden nedan eller tryck (om du är på mobil) för att betala.
          </p>
          <a href={swishUrl} className="self-center text-center">
            <h1 className="text-xl font-bold text-black dark:text-white">Swish</h1>
            <img src={qrCode} alt="Swish QR code" />
          </a>
          <p className="text-black dark:text-white">Har du swishat? Tyck på knappen nedan.</p>
          <Button className="self-stretch" variant="default" onClick={onPayment}>
            {paymentButtonLoading ? 'Laddar' : 'Jag har swishat'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BalanceInSEK({ credits }: { credits: number }) {
  const { token } = useAuthContext();
  const [krToCred, setKrToCred] = useState(1000000 / 10);
  useEffect(() => {
    updateKrToCred(token).then(setKrToCred);
  }, [token]);
  return <span>{Math.floor(credits / krToCred).toLocaleString()} kr</span>;
}

export default SwishModal;
