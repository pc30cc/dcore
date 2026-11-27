import { isolatedNodes } from './isolates';
import { isolateValues, type Translate, type Wording } from './translate';
import { useI18n } from './useI18n';

/**
 * A text worded each time it is drawn, in the panel's language of that
 * moment, so one that stays on screen through a language switch is in the
 * new language. It takes the direction of the element it is in, and each
 * string value in it (a name, an API detail) is a <bdi>: a value in the
 * other script keeps its own order without moving the sentence's
 * punctuation. One <span> holds it all, so that in a flex or grid parent
 * the sentence stays one item rather than one per run and <bdi>.
 */
export function Worded({ text }: { text: Wording }) {
  const { t, locale } = useI18n();
  const say: Translate = (key, values) => t(key, values && isolateValues(values));
  // A line after the first is a secondary one (an API's detail, a request id): smaller, on its own line.
  const [first = '', ...rest] = text(say, locale).split('\n');
  return (
    <span>
      {isolatedNodes(first)}
      {rest.map((line, index) => (
        <span key={index} className="mt-1 block text-xs opacity-80">
          {isolatedNodes(line)}
        </span>
      ))}
    </span>
  );
}
