from PIL import Image
import sys

def remove_background(input_path, output_path, tolerance=240):
    img = Image.open(input_path)
    img = img.convert("RGBA")
    data = img.getdata()
    
    new_data = []
    for item in data:
        # If all r, g, b are above tolerance, it's close to white, make transparent
        if item[0] > tolerance and item[1] > tolerance and item[2] > tolerance:
            new_data.append((255, 255, 255, 0))
        else:
            new_data.append(item)
            
    img.putdata(new_data)
    img.save(output_path, "PNG")

remove_background(sys.argv[1], sys.argv[2])
