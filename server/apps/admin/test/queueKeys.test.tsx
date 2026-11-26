import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useQueueKeys } from '../src/lib/queueKeys';

/** The queues' keys on their own: what they do, and when they leave a key alone. */

function Harness({ handlers }: { handlers: Parameters<typeof useQueueKeys>[0] }) {
  const [dialog, setDialog] = useState(false);
  useQueueKeys(handlers);
  return (
    <div>
      <input aria-label="search" />
      <textarea aria-label="note" />
      <button type="button" onClick={() => setDialog(true)}>
        open dialog
      </button>
      {dialog && (
        <div role="dialog" aria-label="a dialog">
          <button type="button" onClick={() => setDialog(false)}>
            close
          </button>
        </div>
      )}
    </div>
  );
}

function handlers() {
  return { onApprove: vi.fn(), onReject: vi.fn(), onNext: vi.fn(), onPrevious: vi.fn() };
}

describe('the queue keys', () => {
  it('approve with A, reject with R, move with J and K', () => {
    const h = handlers();
    render(<Harness handlers={h} />);
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' });
    fireEvent.keyDown(window, { code: 'KeyR', key: 'r' });
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j' });
    fireEvent.keyDown(window, { code: 'KeyK', key: 'k' });
    expect(h.onApprove).toHaveBeenCalledTimes(1);
    expect(h.onReject).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(1);
    expect(h.onPrevious).toHaveBeenCalledTimes(1);
  });

  it('read the key’s place, so a Persian layout works the same', () => {
    const h = handlers();
    render(<Harness handlers={h} />);
    fireEvent.keyDown(window, { code: 'KeyA', key: 'ش' });
    fireEvent.keyDown(window, { code: 'KeyR', key: 'ق' });
    expect(h.onApprove).toHaveBeenCalledTimes(1);
    expect(h.onReject).toHaveBeenCalledTimes(1);
    // The letter alone on another key does nothing.
    fireEvent.keyDown(window, { code: 'KeyS', key: 'a' });
    expect(h.onApprove).toHaveBeenCalledTimes(1);
  });

  it('do nothing while typing, with a modifier held, or with a dialog open', () => {
    const h = handlers();
    render(<Harness handlers={h} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'search' }), { code: 'KeyA', key: 'a' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'note' }), { code: 'KeyR', key: 'r' });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', ctrlKey: true });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', metaKey: true });
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', altKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'open dialog' }));
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' });
    expect(h.onApprove).not.toHaveBeenCalled();
    expect(h.onReject).not.toHaveBeenCalled();
    expect(h.onNext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j' });
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });

  it('are off when disabled, and a missing handler (no permission) leaves its key alone', () => {
    const h = handlers();
    const { rerender } = render(<Harness handlers={{ ...h, enabled: false }} />);
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j' });
    expect(h.onNext).not.toHaveBeenCalled();
    rerender(<Harness handlers={{ onNext: h.onNext }} />);
    const event = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j' });
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });

  it('acts once per press: a key held down, repeating, does nothing more', () => {
    const h = handlers();
    render(<Harness handlers={h} />);
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' });
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(window, { code: 'KeyA', key: 'a', repeat: true });
    fireEvent.keyDown(window, { code: 'KeyR', key: 'r', repeat: true });
    expect(h.onApprove).toHaveBeenCalledTimes(1);
    expect(h.onReject).not.toHaveBeenCalled();
  });
});
