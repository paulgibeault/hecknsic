from PIL import Image
import collections

def process_image(input_path, output_path, tolerance=30):
    try:
        img = Image.open(input_path).convert("RGBA")
        width, height = img.size
        pixels = img.load()
        
        # BFS for flood fill from corners
        # Start with all 4 corners
        starts = [(0, 0), (width-1, 0), (0, height-1), (width-1, height-1)]
        q = collections.deque(starts)
        visited = set(starts)
        
        # Determine background color from top-left (0,0)
        # We assume the background is white-ish
        bg_color = pixels[0, 0]
        
        # Check if background is actually transparent already
        if bg_color[3] == 0:
            print("Background is already transparent. Skipping flood fill.")
            # Just trim and save
            bbox = img.getbbox()
            if bbox:
                img = img.crop(bbox)
            img.save(output_path, "PNG")
            return

        def is_similar(p1, p2, tol):
            return abs(p1[0] - p2[0]) <= tol and \
                   abs(p1[1] - p2[1]) <= tol and \
                   abs(p1[2] - p2[2]) <= tol

        # Check if corner is white-ish
        if not is_similar(bg_color, (255, 255, 255, 255), tolerance):
            print(f"Warning: Corner color {bg_color} is not white. Proceeding with flood fill anyway using corner color as efficient background.")

        mask = set()
        # Add starts to processing if they match criteria (they naturally match themselves)
        # But we need to verify all starts are similar to bg_color (in case corners have different colors?)
        # For safety, let's just flood from (0,0) and if other corners are connected, they'll get picked up.
        # If corners are disconnected, we might have issues. 
        # Better: Filter starts that are similar to bg_color
        
        q = collections.deque()
        visited = set()
        
        for sx, sy in starts:
            if is_similar(pixels[sx, sy], bg_color, tolerance):
                q.append((sx, sy))
                visited.add((sx, sy))
                mask.add((sx, sy))

        while q:
            x, y = q.popleft()
            
            # Check neighbors
            for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height:
                    if (nx, ny) not in visited:
                        current_pixel = pixels[nx, ny]
                        if is_similar(current_pixel, bg_color, tolerance):
                            visited.add((nx, ny))
                            q.append((nx, ny))
                            mask.add((nx, ny))
        
        print(f"Flood fill identified {len(mask)} background pixels.")
        
        # Apply transparency
        # Create new image data
        # To avoid modifying pixels one by one in a way that might be slow or weird,
        # let's just update the alpha channel.
        
        for x, y in mask:
            p = pixels[x, y]
            pixels[x, y] = (p[0], p[1], p[2], 0)
            
        # Crop the image to non-transparent area
        bbox = img.getbbox()
        if bbox:
            img = img.crop(bbox)
            
        img.save(output_path, "PNG")
        print(f"Successfully processed {input_path} to {output_path}")
    except Exception as e:
        print(f"Error processing image: {e}")

if __name__ == "__main__":
    process_image("img/logo_header.png", "img/logo_header.png")
