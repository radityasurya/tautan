import { expect, test } from 'bun:test';
import { fileImage, fileView, safeImage } from '../web/image.tsx';

test('safeImage keeps https and raster data URLs only', () => {
  expect(safeImage('https://x.test/a b.png')).toBe('https://x.test/a%20b.png');
  expect(safeImage('data:image/webp;base64,UklGRg==')).toBe('data:image/webp;base64,UklGRg==');
  for (const bad of ['http://x.test/a.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', '/api/x', '//x.test/a.png', 'not a url'])
    expect(safeImage(bad)).toBeUndefined();
});

test('the file route and viewer encode the Pane key and the path', () => {
  expect(fileImage('mbp/herdr/w1:p2', 'shots/a #1.png')).toBe('/api/panes/mbp%2Fherdr%2Fw1%3Ap2/file?path=shots%2Fa%20%231.png');
  expect(fileView('mbp/herdr/w1:p2', '/abs/a.png')).toBe('#/file/mbp%2Fherdr%2Fw1%3Ap2?path=%2Fabs%2Fa.png');
});
