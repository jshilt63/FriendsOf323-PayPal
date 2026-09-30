const KMZ_LIBRARY_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

export async function parseRouteFile(file) {
  if (!(file instanceof File)) throw new Error("Choose a KML or KMZ route file.");

  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["kml", "kmz"].includes(extension)) {
    throw new Error("Route files must be Google My Maps KML or KMZ files.");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Route files must be 8 MB or smaller.");
  }

  let kmlText;
  if (extension === "kml") {
    kmlText = await file.text();
  } else {
    kmlText = await extractKmlFromKmz(file);
  }

  const parsed = parseKml(kmlText);
  return {
    ...parsed,
    source_filename: file.name,
    source_format: extension
  };
}

async function extractKmlFromKmz(file) {
  let JSZip;
  try {
    const module = await import(KMZ_LIBRARY_URL);
    JSZip = module.default;
  } catch (error) {
    throw new Error("The KMZ reader could not be loaded. Check your internet connection or export the route as KML instead.");
  }

  let archive;
  try {
    archive = await JSZip.loadAsync(await file.arrayBuffer());
  } catch (error) {
    throw new Error("This KMZ file could not be opened.");
  }

  const kmlFiles = Object.values(archive.files)
    .filter(entry => !entry.dir && entry.name.toLowerCase().endsWith(".kml"));

  if (!kmlFiles.length) throw new Error("The KMZ file does not contain a KML route.");

  const preferred = kmlFiles.find(entry => /(^|\/)doc\.kml$/i.test(entry.name)) || kmlFiles[0];
  return preferred.async("text");
}

function parseKml(kmlText) {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(kmlText, "application/xml");
  if (documentNode.querySelector("parsererror")) {
    throw new Error("The KML file is not valid XML.");
  }

  const lines = [];

  documentNode.querySelectorAll("LineString coordinates").forEach(node => {
    const points = parseCoordinateText(node.textContent || "");
    if (points.length >= 2) lines.push(points);
  });

  // Google exports can also contain gx:Track geometry.
  Array.from(documentNode.getElementsByTagNameNS("*", "Track")).forEach(track => {
    const points = [];
    Array.from(track.getElementsByTagNameNS("*", "coord")).forEach(node => {
      const values = String(node.textContent || "").trim().split(/\s+/).map(Number);
      if (values.length >= 2 && Number.isFinite(values[0]) && Number.isFinite(values[1])) {
        points.push([values[0], values[1]]);
      }
    });
    if (points.length >= 2) lines.push(points);
  });

  if (!lines.length) {
    throw new Error("No route lines were found. In Google My Maps, export a directions/route layer as KML or KMZ.");
  }

  const allPoints = lines.flat();
  const bounds = calculateBounds(allPoints);

  return {
    geometry: {
      type: "MultiLineString",
      coordinates: lines
    },
    point_count: allPoints.length,
    segment_count: lines.length,
    bounds
  };
}

function parseCoordinateText(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .map(token => token.split(",").slice(0, 2).map(Number))
    .filter(point => point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

function calculateBounds(points) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  points.forEach(([lng, lat]) => {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  });

  return {
    min_lng: minLng,
    min_lat: minLat,
    max_lng: maxLng,
    max_lat: maxLat
  };
}
