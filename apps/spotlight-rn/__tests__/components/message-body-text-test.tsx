import { render, screen } from '@testing-library/react-native';

import { MessageBodyText, splitMessageBody } from '@/features/social/components/message-body-text';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

/*
  ───────────────────────────────────────────────────────────────────────────────
  A LINK THE SENDER CANNOT SEE IS A LINK THAT ISN'T THERE
  ───────────────────────────────────────────────────────────────────────────────
  Reported three times as "sharing a wishlist just sends text", and misdiagnosed
  twice, because every check said the link was being produced — and it was. It was
  rendered, it occupied its line, it was tappable. It was painted `purple500` on
  the sender's own bubble, which IS `purple500` (`dm-thread-screen.tsx`).

  The tell was the reporter mentioning "3 new lines for some reason": the share
  body only appends `\n\n<link>` WHEN there is a link, so blank lines proved the
  link was present while the eye said it was absent.

  It only ever broke for the sender. The recipient's bubble is `gray100`, so they
  saw it fine — i.e. the one person who could not see it was the one testing it.
*/
describe('MessageBodyText', () => {
  const BODY = "Check out Misty's wishlist\n\nspotlight://u/misty?tab=wishlist";

  it('splits a shared link out of the surrounding text', () => {
    const segments = splitMessageBody(BODY);
    expect(segments).toContainEqual({
      kind: 'link',
      value: 'spotlight://u/misty?tab=wishlist',
      path: '/u/misty?tab=wishlist',
    });
  });

  it('paints the link in the colour the caller asks for, so it survives a tinted bubble', () => {
    render(<MessageBodyText body={BODY} linkColor="#FFFFFF" testID="body" />);

    const link = screen.getByTestId('body-link-1');
    const style = Array.isArray(link.props.style)
      ? Object.assign({}, ...link.props.style)
      : link.props.style;
    expect(style.color).toBe('#FFFFFF');
  });

  it('underlines links, so one is still legible where colour cannot carry it', () => {
    render(<MessageBodyText body={BODY} linkColor="#FFFFFF" testID="body" />);

    const link = screen.getByTestId('body-link-1');
    const style = Array.isArray(link.props.style)
      ? Object.assign({}, ...link.props.style)
      : link.props.style;
    expect(style.textDecorationLine).toBe('underline');
  });

  it('leaves a hostile path as plain text rather than a tap target', () => {
    render(<MessageBodyText body="spotlight://../../admin" testID="body" />);

    expect(screen.queryByTestId('body-link-0')).toBeNull();
  });
});
