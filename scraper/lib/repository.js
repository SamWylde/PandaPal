import { Sequelize } from 'sequelize';
const Op = Sequelize.Op;

const DATABASE_URI = process.env.DATABASE_URI;

if (DATABASE_URI) {
  console.log('DATABASE_URI is set. Length:', DATABASE_URI.length);
} else {
  console.log('DATABASE_URI is NOT set. Scraper will run without database persistence.');
}

let database;
// Ensure DATABASE_URI is a valid string and not pointing to localhost unless explicitly intended
if (DATABASE_URI && DATABASE_URI.startsWith('postgres') && !DATABASE_URI.includes('127.0.0.1') && !DATABASE_URI.includes('localhost')) {
  database = new Sequelize(DATABASE_URI, {
    logging: false,
    pool: { max: 30, min: 5, idle: 20 * 60 * 1000 },
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    }
  });
} else {
  if (DATABASE_URI) {
    console.warn('DATABASE_URI found but looks invalid or points to localhost. Skipping connection to avoid ECONNREFUSED.');
  }
  database = {
    define: () => ({
      findOne: () => Promise.resolve(null),
      findAll: () => Promise.resolve([]),
      hasMany: () => { },
      belongsTo: () => { }
    })
  };
}

const Torrent = database.define('torrent',
  {
    infoHash: { type: Sequelize.STRING(64), primaryKey: true },
    provider: { type: Sequelize.STRING(32), allowNull: false },
    torrentId: { type: Sequelize.STRING(128) },
    title: { type: Sequelize.STRING(256), allowNull: false },
    size: { type: Sequelize.BIGINT },
    type: { type: Sequelize.STRING(16), allowNull: false },
    uploadDate: { type: Sequelize.DATE, allowNull: false },
    seeders: { type: Sequelize.SMALLINT },
    trackers: { type: Sequelize.STRING(4096) },
    languages: { type: Sequelize.STRING(4096) },
    resolution: { type: Sequelize.STRING(16) }
  }
);

const File = database.define('file',
  {
    id: { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true },
    infoHash: {
      type: Sequelize.STRING(64),
      allowNull: false,
      references: { model: Torrent, key: 'infoHash' },
      onDelete: 'CASCADE'
    },
    fileIndex: { type: Sequelize.INTEGER },
    title: { type: Sequelize.STRING(256), allowNull: false },
    size: { type: Sequelize.BIGINT },
    imdbId: { type: Sequelize.STRING(32) },
    imdbSeason: { type: Sequelize.INTEGER },
    imdbEpisode: { type: Sequelize.INTEGER },
    kitsuId: { type: Sequelize.INTEGER },
    kitsuEpisode: { type: Sequelize.INTEGER }
  },
);

const Subtitle = database.define('subtitle',
  {
    infoHash: {
      type: Sequelize.STRING(64),
      allowNull: false,
      references: { model: Torrent, key: 'infoHash' },
      onDelete: 'CASCADE'
    },
    fileIndex: { type: Sequelize.INTEGER, allowNull: false },
    fileId: {
      type: Sequelize.BIGINT,
      allowNull: true,
      references: { model: File, key: 'id' },
      onDelete: 'SET NULL'
    },
    title: { type: Sequelize.STRING(512), allowNull: false },
    size: { type: Sequelize.BIGINT, allowNull: false },
  },
  { timestamps: false }
);

Torrent.hasMany(File, { foreignKey: 'infoHash', constraints: false });
File.belongsTo(Torrent, { foreignKey: 'infoHash', constraints: false });
File.hasMany(Subtitle, { foreignKey: 'fileId', constraints: false });
Subtitle.belongsTo(File, { foreignKey: 'fileId', constraints: false });

export function getTorrent(infoHash) {
  return Torrent.findOne({ where: { infoHash: infoHash } });
}

export function getFiles(infoHashes) {
  return File.findAll({ where: { infoHash: { [Op.in]: infoHashes } } });
}

export function getImdbIdMovieEntries(imdbId) {
  return File.findAll({
    where: {
      imdbId: { [Op.eq]: imdbId }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getImdbIdSeriesEntries(imdbId, season, episode) {
  return File.findAll({
    where: {
      imdbId: { [Op.eq]: imdbId },
      imdbSeason: { [Op.eq]: season },
      imdbEpisode: { [Op.eq]: episode }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getKitsuIdMovieEntries(kitsuId) {
  return File.findAll({
    where: {
      kitsuId: { [Op.eq]: kitsuId }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getKitsuIdSeriesEntries(kitsuId, episode) {
  return File.findAll({
    where: {
      kitsuId: { [Op.eq]: kitsuId },
      kitsuEpisode: { [Op.eq]: episode }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}
