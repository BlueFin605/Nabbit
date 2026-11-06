import { environment } from '../../../environments/environment';
import { imageUrl } from './image-url';

describe('imageUrl', () => {
  it('joins the image base URL and key, keeping the owner/uuid slash', () => {
    expect(imageUrl('owner 1/abc-123')).toBe(`${environment.imageBaseUrl}/owner%201/abc-123`);
  });
});
