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
  const clothing = schema?.clothing && typeof schema.clothing === 'object' ? schema.clothing : {};
  const dominantColors = Array.isArray(clothing.dominantColors)
    ? clothing.dominantColors.filter(Boolean)
    : [];
  return {
    dominantColors,
    top: convertClothingItem(clothing.top),
    bottom: convertClothingItem(clothing.trousers),
    outerwear: convertClothingItem(clothing.jacket),
    footwear: convertClothingItem(clothing.shoes),
    dress: convertClothingItem(clothing.dress)
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
  const hair = schema.hair && typeof schema.hair === 'object' ? schema.hair : {};

  return {
    subject: {
      gender: schema.gender_presentation?.value || 'unknown',
      ageRange: schema.age_band?.value || schema.age_band || 'unknown',
      build: schema.build?.value || 'unknown',
      bodyType: schema.build?.value || 'unknown',
      skinTone: schema.skin_tone?.value || 'unknown',
      hair: {
        color: hair.color?.value || 'unknown',
        length: hair.length?.value || 'unknown',
        style: hair.style?.value || 'unknown'
      },
      eyewear: pickAccessory(accessoriesList, 'glasses'),
      headwear: pickAccessory(accessoriesList, 'hat'),
      distinguishingFeatures: extractDistinctiveMarks(schema)
    },
    clothing: buildClothingAnalysis(schema),
    accessories: buildAccessoriesMap(accessoriesList),
    carriedItems: Array.isArray(schema.carried_items) ? schema.carried_items.filter(Boolean) : []
  };
}

module.exports = {
  schemaToVisionAnalysis
};
