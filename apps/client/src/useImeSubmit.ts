import { useRef, type KeyboardEvent } from "react";

/** WebView/desktop IMEs can emit a final Enter after compositionend. */
export function useImeSubmit() {
  const composing = useRef(false),
    endedAt = useRef(-Infinity);
  const blocked = () =>
    composing.current || performance.now() - endedAt.current < 50;
  return {
    blocked,
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
      endedAt.current = performance.now();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229)
        endedAt.current = performance.now();
      if (
        event.key === "Enter" &&
        (blocked() || event.nativeEvent.isComposing || event.keyCode === 229)
      )
        event.preventDefault();
    },
  };
}
