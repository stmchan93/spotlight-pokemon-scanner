import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

/** Figma "Ekalight AI" gradient (6430:11314): yellow -> orange -> pink -> magenta -> purple. */
const EKALIGHT_AI_STOPS = [
  { offset: '0', color: '#FEE333' },
  { offset: '0.25', color: '#FFB547' },
  { offset: '0.5', color: '#FF7A8A' },
  { offset: '0.75', color: '#E35BD8' },
  { offset: '1', color: '#A54BFA' },
] as const;

function gradientStops() {
  return EKALIGHT_AI_STOPS.map((stop) => <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />);
}

/** The Ask Ekalight "flare" sparkle, the exact Figma 6430:11314 path, 22pt. */
export function EkalightAiSparkle({ size = 22 }: { size?: number }) {
  return (
    <Svg fill="none" height={size} testID="ekalight-ai-sparkle" viewBox="0 0 22 22" width={size}>
      <Defs>
        <LinearGradient gradientUnits="userSpaceOnUse" id="ekalightAiSparkle" x1="0.98" x2="23.888" y1="1.438" y2="5.567">
          {gradientStops()}
        </LinearGradient>
      </Defs>
      <Path
        clipRule="evenodd"
        d="M11 3.00074L8.49924 8.3595C8.37632 8.62291 8.16458 8.83465 7.90116 8.95758L2.5424 11.4583L7.90116 13.9591C8.16458 14.082 8.37632 14.2938 8.49924 14.5572L11 19.9159L13.5008 14.5572C13.6237 14.2938 13.8354 14.082 14.0988 13.9591L19.4576 11.4583L14.0988 8.95758C13.8354 8.83465 13.6237 8.62291 13.5008 8.3595L11 3.00074ZM9.8786 2.15227C10.323 1.20003 11.677 1.20003 12.1214 2.15227L14.7256 7.73272L20.3061 10.3369C21.2583 10.7813 21.2583 12.1354 20.3061 12.5797L14.7256 15.1839L12.1214 20.7644C11.677 21.7166 10.323 21.7166 9.8786 20.7644L7.27439 15.1839L1.69393 12.5797C0.741696 12.1354 0.741695 10.7813 1.69393 10.3369L7.27439 7.73272L9.8786 2.15227Z"
        fill="url(#ekalightAiSparkle)"
        fillRule="evenodd"
      />
    </Svg>
  );
}

/** The Social bar's Ask Ekalight "flare" (Figma 6597:3481): the star plus a small spark at its top-right, 22pt. */
export function EkalightAiFlare({ size = 22 }: { size?: number }) {
  return (
    <Svg fill="none" height={size} testID="ekalight-ai-flare" viewBox="0 0 22 22" width={size}>
      <Defs>
        <LinearGradient gradientUnits="userSpaceOnUse" id="ekalightAiFlareStar" x1="0" x2="21.7188" y1="3" y2="6.91426">
          {gradientStops()}
        </LinearGradient>
        <LinearGradient gradientUnits="userSpaceOnUse" id="ekalightAiFlareSpark" x1="14" x2="23.1448" y1="0.167163" y2="1.81527">
          {gradientStops()}
        </LinearGradient>
      </Defs>
      <Path
        clipRule="evenodd"
        d="M9.5 4.48151L7.12908 9.56205C7.01254 9.81179 6.81179 10.0125 6.56205 10.1291L1.48151 12.5L6.56205 14.8709C6.81179 14.9875 7.01254 15.1882 7.12908 15.4379L9.5 20.5185L11.8709 15.4379C11.9875 15.1882 12.1882 14.9875 12.4379 14.8709L17.5185 12.5L12.4379 10.1291C12.1882 10.0125 11.9875 9.81179 11.8709 9.56205L9.5 4.48151ZM8.43682 3.6771C8.85813 2.7743 10.1419 2.7743 10.5632 3.6771L13.0322 8.96782L18.3229 11.4368C19.2257 11.8581 19.2257 13.1419 18.3229 13.5632L13.0322 16.0322L10.5632 21.3229C10.1419 22.2257 8.85813 22.2257 8.43682 21.3229L5.96782 16.0322L0.6771 13.5632C-0.2257 13.1419 -0.2257 11.8581 0.677099 11.4368L5.96782 8.96782L8.43682 3.6771Z"
        fill="url(#ekalightAiFlareStar)"
        fillRule="evenodd"
      />
      <Path
        clipRule="evenodd"
        d="M18 0.790958L17.0017 2.93013C16.9526 3.03529 16.8681 3.11981 16.763 3.16888L14.6238 4.16716L16.763 5.16544C16.8681 5.21452 16.9526 5.29904 17.0017 5.40419L18 7.54337L18.9983 5.40419C19.0473 5.29904 19.1319 5.21452 19.237 5.16544L21.3762 4.16716L19.237 3.16888C19.1319 3.11981 19.0473 3.03529 18.9983 2.93013L18 0.790958ZM17.5523 0.452257C17.7297 0.0721313 18.2702 0.072131 18.4476 0.452257L19.4872 2.67993L21.7149 3.71951C22.095 3.8969 22.095 4.43742 21.7149 4.61482L19.4872 5.6544L18.4476 7.88207C18.2702 8.26219 17.7297 8.26219 17.5523 7.88207L16.5128 5.6544L14.2851 4.61482C13.905 4.43742 13.905 3.8969 14.2851 3.71951L16.5128 2.67993L17.5523 0.452257Z"
        fill="url(#ekalightAiFlareSpark)"
        fillRule="evenodd"
      />
    </Svg>
  );
}

/** The 1pt gradient ring around the Ask Ekalight bubble (Figma 6430:11312 "Glass Effect" stroke). */
export function EkalightAiRing({ size }: { size: number }) {
  const stroke = 1;
  return (
    <Svg height={size} pointerEvents="none" style={StyleSheet.absoluteFill} testID="ekalight-ai-ring" width={size}>
      <Defs>
        <LinearGradient id="ekalightAiRing" x1="0" x2="1" y1="0" y2="0.18">
          {gradientStops()}
        </LinearGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} fill="none" r={(size - stroke) / 2} stroke="url(#ekalightAiRing)" strokeWidth={stroke} />
    </Svg>
  );
}

/** The 1pt gradient ring around the header's Chat pill (Figma 6725:8999 "Glass Effect" stroke). */
export function EkalightAiPillRing({ height, width }: { height: number; width: number }) {
  const stroke = 1;
  return (
    <Svg height={height} pointerEvents="none" style={StyleSheet.absoluteFill} testID="ekalight-ai-pill-ring" width={width}>
      <Defs>
        <LinearGradient id="ekalightAiPillRing" x1="0" x2="1" y1="0" y2="0.18">
          {gradientStops()}
        </LinearGradient>
      </Defs>
      <Rect
        fill="none"
        height={height - stroke}
        rx={(height - stroke) / 2}
        stroke="url(#ekalightAiPillRing)"
        strokeWidth={stroke}
        width={width - stroke}
        x={stroke / 2}
        y={stroke / 2}
      />
    </Svg>
  );
}
