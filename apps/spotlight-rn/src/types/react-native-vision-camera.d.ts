// vision-camera v5 under-declares `testID` on the <Camera> props, but it forwards
// testID to the underlying native view at runtime (and our jest mock + Maestro hooks
// rely on it). Declare it so our testID-tagged <Camera> usages typecheck.
import 'react-native-vision-camera';

declare module 'react-native-vision-camera' {
  interface CameraProps {
    testID?: string;
  }
}
