const {
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./db.js');

async function ensurePersonGroupSequence(pool) {
  await pool.query('CREATE SEQUENCE IF NOT EXISTS single_person_group_id_seq');
  const maxResult = await pool.query(`
    SELECT COALESCE(MAX(person_group_id), 0) AS max_id
    FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
  `);
  const maxId = Number(maxResult.rows?.[0]?.max_id || 0);

  const seqState = await pool.query(`
    SELECT last_value, is_called
    FROM single_person_group_id_seq
  `);
  const seqValue = Number(seqState.rows?.[0]?.last_value || 0);
  const isCalled = Boolean(seqState.rows?.[0]?.is_called);

  if (!isCalled && maxId === 0) {
    return;
  }

  if (!isCalled || maxId > seqValue) {
    const target = Math.max(maxId, seqValue);
    await pool.query(
      `SELECT setval('single_person_group_id_seq', $1, $2)`,
      [target, target !== 0]
    );
  }
}

async function allocatePersonGroupId(pool) {
  await ensurePersonGroupSequence(pool);
  const nextResult = await pool.query(`SELECT nextval('single_person_group_id_seq') AS next_id`);
  return Number(nextResult.rows?.[0]?.next_id);
}

module.exports = {
  allocatePersonGroupId
};

