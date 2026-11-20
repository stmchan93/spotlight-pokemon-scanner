import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

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
