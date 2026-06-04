const data = require('./src/data/furniture_library.json');

const bedEntries = data.furniture.filter(f => f.furnitureName === 'Bed');

bedEntries.forEach(entry => {
  const aptType = entry.apartmentType;
  const category = entry.category;
  const numVariants = entry.pieces[0].variants.length;
  
  console.log(`${aptType}_${category}_Bed: ${numVariants} variant(s)`);
  
  if (numVariants > 0) {
    const v1 = entry.pieces[0].variants[0];
    const bbox = v1.bboxBig;
    console.log(`  V1: ${bbox.width} x ${bbox.height} (rot: ${bbox.rotation}°)`);
  }
  
  if (numVariants > 1) {
    const v2 = entry.pieces[0].variants[1];
    const bbox = v2.bboxBig;
    console.log(`  V2: ${bbox.width} x ${bbox.height} (rot: ${bbox.rotation}°)`);
  }
});
