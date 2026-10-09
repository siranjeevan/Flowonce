const { Jimp } = require('jimp');

async function processIcon() {
  const imagePath = '/Users/Jeevith/Jeevith/Flowonce/src/assets/image.png';
  const out16 = '/Users/Jeevith/Jeevith/Flowonce/public/icon16.png';
  const out48 = '/Users/Jeevith/Jeevith/Flowonce/public/icon48.png';
  const out128 = '/Users/Jeevith/Jeevith/Flowonce/public/icon128.png';

  // Read the source image
  const image = await Jimp.read(imagePath);
  
  // Create a white background image of the same size
  const bg = new Jimp({ width: image.bitmap.width, height: image.bitmap.height, color: '#FFFFFF' });
  
  // Composite the original image over the white background
  bg.composite(image, 0, 0);

  // Resize and save
  await bg.clone().resize({ w: 16, h: 16 }).write(out16);
  await bg.clone().resize({ w: 48, h: 48 }).write(out48);
  await bg.clone().resize({ w: 128, h: 128 }).write(out128);
  
  console.log('Successfully processed icons with white background.');
}

processIcon().catch(err => {
  console.error(err);
  process.exit(1);
});
