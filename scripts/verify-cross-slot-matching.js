#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  evaluateDescriptionGrouping
} = require('../netlify/functions/shared/single-description');

const canonicalSchema = {
  visible_confidence: 80,
  lighting_uncertainty: 10,
  clothing: {
    top: {
      description: 'blazer',
      color: 'pink',
      permanence: 'stable',
      confidence: 80,
      rare_flag: false
    },
    jacket: {
      description: 'unknown',
      color: 'unknown',
      permanence: 'unknown',
      confidence: 0,
      rare_flag: false
    },
    trousers: {
      description: 'slacks',
      color: 'green',
      permanence: 'stable',
      confidence: 80,
      rare_flag: false
    },
    shoes: {
      description: 'unknown',
      color: 'unknown',
      permanence: 'unknown',
      confidence: 0,
      rare_flag: false
    },
    dress: {
      description: 'unknown',
      color: 'unknown',
      permanence: 'unknown',
      confidence: 0,
      rare_flag: false
    }
  },
  hair: {
    color: { value: 'grey', confidence: 80 },
    length: { value: 'short', confidence: 70 },
    style: { value: 'curly', confidence: 70 },
    facial_hair: { value: 'none', confidence: 90 }
  },
  build: { value: 'average', confidence: 70 },
  age_band: { value: '55+', confidence: 80 },
  skin_tone: { value: 'light', confidence: 70 },
  gender_presentation: { value: 'male', confidence: 90 },
  height_impression: { value: 'average', confidence: 60 },
  accessories: [
    {
      type: 'other',
      description: 'suspenders',
      confidence: 70,
      permanence: 'stable',
      location: 'unknown',
      rare_flag: false
    }
  ],
  distinctive_marks: [
    {
      type: 'unknown',
      description: 'unknown',
      location: 'unknown',
      confidence: 0,
      rarity_score: 0
    }
  ],
  visible_area: 'upper_body'
};

const incomingSchema = {
  visible_confidence: 85,
  lighting_uncertainty: 10,
  clothing: {
    top: {
      description: 'white shirt',
      color: 'white',
      permanence: 'stable',
      confidence: 85,
      rare_flag: false
    },
    jacket: {
      description: 'light pink blazer',
      color: 'pink',
      permanence: 'stable',
      confidence: 90,
      rare_flag: true
    },
    trousers: {
      description: 'light green trousers',
      color: 'green',
      permanence: 'stable',
      confidence: 80,
      rare_flag: false
    },
    shoes: {
      description: 'unknown',
      color: 'unknown',
      permanence: 'unknown',
      confidence: 0,
      rare_flag: false
    },
    dress: {
      description: 'unknown',
      color: 'unknown',
      permanence: 'unknown',
      confidence: 0,
      rare_flag: false
    }
  },
  hair: {
    color: { value: 'grey', confidence: 80 },
    length: { value: 'short', confidence: 70 },
    style: { value: 'curly', confidence: 75 },
    facial_hair: { value: 'none', confidence: 90 }
  },
  build: { value: 'average', confidence: 70 },
  age_band: { value: '55+', confidence: 80 },
  skin_tone: { value: 'light', confidence: 70 },
  gender_presentation: { value: 'male', confidence: 90 },
  height_impression: { value: 'unknown', confidence: 50 },
  accessories: [],
  distinctive_marks: [],
  visible_area: 'upper_body'
};

async function main() {
  const result = await evaluateDescriptionGrouping(incomingSchema, [
    {
      group_id: 146,
      group_member_count: 1,
      group_canonical: canonicalSchema
    }
  ]);

  assert.equal(
    result.bestGroupId,
    146,
    'Expected cross-slot blazer match to pick existing group'
  );
  assert(
    result.bestGroupProbability >= 60,
    `Expected likelihood to exceed grouping threshold, got ${result.bestGroupProbability}`
  );

  console.log('Cross-slot matching sanity check passed:', result);
}

main().catch((error) => {
  console.error('Cross-slot matching sanity check failed:', error);
  process.exitCode = 1;
});

