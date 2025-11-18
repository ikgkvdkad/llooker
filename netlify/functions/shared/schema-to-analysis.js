function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function toLowerSafe(value) {
  return normalizeString(value).toLowerCase();
}

function convertClothingItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const description = normalizeString(item.description) || 'unknown';
  const color = normalizeString(item.color);
  const colors = color && color !== 'unknown' ? [color] : [];
  return {
    category: description,
    colors,
    pattern: null,
    style: null,
    permanence: normalizeString(item.permanence) || 'unknown'
  };
}

function buildClothingAnalysis(schema) {
  if (!schema || typeof schema !== 'object') {
    return {
      dominantColors: [],
      top: null,
      bottom: null,
      outerwear: null,
      footwear: null
    };
  }
  
  const topColor = normalizeString(schema.top_color);
  const bottomColor = normalizeString(schema.bottom_color);
  const shoesColor = normalizeString(schema.shoes_color);
  const jacketColor = normalizeString(schema.jacket_color);
  
  const dominantColors = [topColor, bottomColor, jacketColor]
    .filter(c => c && c !== 'unknown')
    .slice(0, 3);
  
  return {
    dominantColors,
    top: {
      category: normalizeString(schema.top_description) || 'unknown',
      colors: topColor && topColor !== 'unknown' ? [topColor] : [],
      pattern: null,
      style: null
    },
    bottom: {
      category: normalizeString(schema.bottom_description) || 'unknown',
      colors: bottomColor && bottomColor !== 'unknown' ? [bottomColor] : [],
      pattern: null,
      style: null
    },
    outerwear: {
      category: normalizeString(schema.jacket_description) || 'unknown',
      colors: jacketColor && jacketColor !== 'unknown' ? [jacketColor] : [],
      pattern: null,
      style: null
    },
    footwear: {
      category: normalizeString(schema.shoes_description) || 'unknown',
      colors: shoesColor && shoesColor !== 'unknown' ? [shoesColor] : [],
      pattern: null,
      style: null
    }
  };
}

function buildAccessoriesMap(accessoriesList) {
  const map = {};
  for (const accessory of accessoriesList) {
    if (!accessory || typeof accessory !== 'object') {
      continue;
    }
    const type = toLowerSafe(accessory.type) || 'other';
    const desc = normalizeString(accessory.description) || type;
    if (!map[type]) {
      map[type] = [];
    }
    map[type].push(desc);
  }
  return map;
}

function pickAccessory(accessoriesList, targetType) {
  for (const accessory of accessoriesList) {
    if (!accessory || typeof accessory !== 'object') continue;
    if (toLowerSafe(accessory.type) === targetType) {
      const desc = normalizeString(accessory.description);
      if (desc && desc !== 'unknown') {
        return desc;
      }
    }
  }
  return `no-${targetType}`;
}

function extractDistinctiveMarks(schema) {
  const marks = Array.isArray(schema?.distinctive_marks) ? schema.distinctive_marks : [];
  return marks
    .map((mark) => normalizeString(mark?.description))
    .filter((desc) => desc && desc !== 'unknown');
}

function schemaToVisionAnalysis(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  const accessoriesList = Array.isArray(schema.accessories) ? schema.accessories : [];

  return {
    subject: {
      gender: normalizeString(schema.gender) || 'unknown',
      ageRange: normalizeString(schema.age_range) || 'unknown',
      build: normalizeString(schema.build) || 'unknown',
      bodyType: normalizeString(schema.build) || 'unknown',
      skinTone: normalizeString(schema.skin_tone) || 'unknown',
      hair: {
        color: normalizeString(schema.hair_color) || 'unknown',
        length: normalizeString(schema.hair_length) || 'unknown',
        style: normalizeString(schema.hair_style) || 'unknown'
      },
      eyewear: pickAccessory(accessoriesList, 'glasses'),
      headwear: pickAccessory(accessoriesList, 'hat'),
      distinguishingFeatures: extractDistinctiveMarks(schema)
    },
    clothing: buildClothingAnalysis(schema),
    accessories: buildAccessoriesMap(accessoriesList),
    carriedItems: []
  };
}

module.exports = {
  schemaToVisionAnalysis
};
