import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import * as turf from '@turf/turf';
import { ChevronsDown, ChevronsUp, ArrowDown, ArrowUp, Download, Eye, EyeOff, Layers, LocateFixed, MousePointer2, Save, SquarePen, SquareX, Trash2, UploadCloud } from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5000/api';
const EDITING_SESSION_ID = getEditingSessionId();
const INITIAL_MAP_CENTER = [30.3753, 69.3451];
const INITIAL_MAP_ZOOM = 5;
const palette = ['#116466', '#2563eb', '#c2410c', '#7c3aed', '#15803d', '#be123c'];

// App owns the full GIS editor state: available shapefile layers, loaded GeoJSON features,
// the active layer, and the one layer currently allowed to edit.
function App() {
  const [datasets, setDatasets] = useState([]);
  const [layerOrder, setLayerOrder] = useState([]);
  const [layersById, setLayersById] = useState({});
  const [activeDatasetId, setActiveDatasetId] = useState(null);
  const [editingDatasetId, setEditingDatasetId] = useState(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState(null);
  const [selectedFeatureIds, setSelectedFeatureIds] = useState([]);
  const [pendingEdit, setPendingEdit] = useState(null);
  const [schemaDirtyDatasetId, setSchemaDirtyDatasetId] = useState(null);
  const [zoomRequest, setZoomRequest] = useState(null);
  const [layerZoomRequest, setLayerZoomRequest] = useState(null);
  const [attributeTableHeight, setAttributeTableHeight] = useState(230);
  const [attributeTableCollapsed, setAttributeTableCollapsed] = useState(true);
  const [attributeTableResizing, setAttributeTableResizing] = useState(false);
  const [stopEditingPrompt, setStopEditingPrompt] = useState(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [status, setStatus] = useState('Ready');
  const [statusKind, setStatusKind] = useState('info');
  const [isBusy, setIsBusy] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const uploadInputRef = useRef(null);
  const preserveMapViewRef = useRef(() => {});
  const flushEditableFeatureRef = useRef(() => null);
  const setAppStatus = useMemo(
    () => setAppStatusFactory(setStatus, setStatusKind),
    [],
  );

  const activeLayer = activeDatasetId && layersById[activeDatasetId]?.visible
    ? layersById[activeDatasetId]
    : null;
  const selectedFeature = useMemo(() => {
    if (pendingEdit?.datasetId === activeDatasetId && pendingEdit.feature?.clientId === selectedFeatureId) {
      return pendingEdit.feature;
    }
    if (pendingEdit?.datasetId === activeDatasetId && pendingEdit.kind === 'split') {
      return pendingEdit.features.find((feature) => feature.clientId === selectedFeatureId) ?? null;
    }
    return activeLayer?.features.find((feature) => feature.clientId === selectedFeatureId) ?? null;
  }, [activeLayer, activeDatasetId, pendingEdit, selectedFeatureId]);
  const tableRowHeight = attributeTableCollapsed ? 34 : attributeTableHeight;

  // Ask MapEditor to capture the exact Leaflet center/zoom before actions that redraw layers.
  const preserveCurrentMapView = useCallback(() => {
    preserveMapViewRef.current();
  }, []);

  // Hide the introduction for the current page session only.
  const closeWelcome = () => {
    setShowWelcome(false);
  };

  // Read the live selected Leaflet edit layer before saving, covering fast move/edit interactions.
  const mergeLiveEditableFeature = (datasetId, editToSave) => {
    const liveFeature = flushEditableFeatureRef.current?.();
    if (!liveFeature || datasetId !== activeDatasetId) return editToSave;
    if (editToSave?.kind === 'split') {
      return {
        ...editToSave,
        features: editToSave.features.map((feature) =>
          feature.clientId === liveFeature.clientId ? liveFeature : feature,
        ),
      };
    }
    if (editToSave?.kind === 'new' && editToSave.feature.clientId === liveFeature.clientId) {
      return { ...editToSave, feature: liveFeature };
    }
    return { datasetId, kind: 'update', feature: liveFeature };
  };

  // Load lightweight dataset records for the left layer list.
  const loadDatasets = useCallback(async () => {
    const response = await apiFetch('/datasets');
    if (!response.ok) throw new Error('Could not load datasets.');
    const data = await response.json();
    setDatasets(data);
    setLayerOrder((current) => mergeLayerOrder(current, data.map((dataset) => dataset.id)));
    setLayersById((current) => {
      const next = { ...current };
      data.forEach((dataset, index) => {
        if (!next[dataset.id]) {
          next[dataset.id] = emptyLayer(dataset, index);
        } else {
          const loadedFeatureCount = next[dataset.id].loaded ? next[dataset.id].features.length : null;
          next[dataset.id] = {
            ...next[dataset.id],
            ...dataset,
            featureCount: loadedFeatureCount ?? dataset.featureCount,
          };
        }
      });
      return next;
    });
    return data;
  }, []);

  // Load one shapefile layer as GeoJSON features for map display and table browsing.
  const loadLayer = useCallback(async (id, options = {}) => {
    setIsBusy(true);
    try {
      const response = await apiFetch(`/datasets/${id}`);
      if (!response.ok) throw new Error('Could not open dataset.');
      const data = await response.json();
      setLayersById((current) => ({
        ...current,
        [id]: {
          ...(current[id] ?? {}),
          id,
          name: data.name,
          geometryType: data.geometryType,
          featureCount: data.features.length,
          color: current[id]?.color ?? palette[Object.keys(current).length % palette.length],
          visible: current[id]?.visible ?? false,
          loaded: true,
          features: normalizeFeatures(data.features),
        },
      }));
      if (options.activate && (currentLayerVisible(id, layersById) || options.forceActivate)) {
        setActiveDatasetId(id);
        setSelectedFeatureId(null);
        setSelectedFeatureIds([]);
      }
      setAppStatus(`Loaded ${data.name}`);
      return data;
    } catch (error) {
      setAppStatus(error.message, 'error');
      return null;
    } finally {
      setIsBusy(false);
    }
  }, [layersById, setAppStatus]);

  // Bootstrap the layer list when the app opens.
  useEffect(() => {
    loadDatasets().catch((error) => setAppStatus(error.message, 'error'));
  }, [loadDatasets, setAppStatus]);

  // Upload one ZIP; the backend may return several shapefile layers from that single ZIP.
  const uploadDataset = async (event) => {
    event.preventDefault();
    if (!uploadFile) return;

    setIsBusy(true);
    setAppStatus('Uploading shapefile zip...');
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      const response = await apiFetch('/datasets/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error(formatUploadError(await response.text()));
      const uploaded = await response.json();
      await loadDatasets();
      await Promise.all(uploaded.map((dataset) => loadLayer(dataset.id)));
      if (uploaded.length > 0) {
        setActiveDatasetId(null);
        setSelectedFeatureId(null);
        setSelectedFeatureIds([]);
        setUploadFile(null);
        if (uploadInputRef.current) uploadInputRef.current.value = '';
        setAppStatus(`Uploaded ${uploaded.length} shapefile layer${uploaded.length === 1 ? '' : 's'}`);
      }
    } catch (error) {
      setAppStatus(error.message, 'error');
    } finally {
      setIsBusy(false);
    }
  };

  // Enable editing for one shapefile layer only; other loaded layers stay view-only.
  const startEditing = async (datasetId) => {
    if (
      editingDatasetId
      && editingDatasetId !== datasetId
      && (pendingEdit?.datasetId === editingDatasetId || schemaDirtyDatasetId === editingDatasetId)
    ) {
      setStopEditingPrompt({ datasetId: editingDatasetId, nextDatasetId: datasetId });
      return;
    }

    await activateEditingLayer(datasetId);
  };

  // Switch the editable layer after any required unsaved-edit decision has already been made.
  const activateEditingLayer = async (datasetId) => {
    preserveCurrentMapView();
    if (!layersById[datasetId]?.loaded) {
      await loadLayer(datasetId);
    }

    setLayersById((current) => ({
      ...current,
      [datasetId]: {
        ...current[datasetId],
        visible: true,
      },
    }));
    setActiveDatasetId(datasetId);
    setEditingDatasetId(datasetId);
    setSelectedFeatureId(null);
    setSelectedFeatureIds([]);
    setPendingEdit(null);
    setSchemaDirtyDatasetId(null);
    setAppStatus('Editing mode enabled');
  };

  // Disable Leaflet Draw editing controls without unloading visible layers.
  const stopEditing = () => {
    if (!editingDatasetId) return;
    setStopEditingPrompt({ datasetId: editingDatasetId, nextDatasetId: null });
  };

  // Exit edit mode after the user has chosen how to handle edits.
  const finishStopEditing = async () => {
    const nextDatasetId = stopEditingPrompt?.nextDatasetId ?? null;
    preserveCurrentMapView();
    setEditingDatasetId(null);
    setPendingEdit(null);
    setSchemaDirtyDatasetId(null);
    setStopEditingPrompt(null);
    setAppStatus(nextDatasetId ? 'Switching editing layer...' : 'Editing mode stopped');
    if (nextDatasetId) {
      await activateEditingLayer(nextDatasetId);
    }
  };

  // Save the current editing layer before turning editing off.
  const saveAndStopEditing = async () => {
    const datasetId = stopEditingPrompt?.datasetId;
    const layer = datasetId ? layersById[datasetId] : null;
    if (!datasetId || !layer) return;
    const editToSave = mergeLiveEditableFeature(datasetId, pendingEdit?.datasetId === datasetId ? pendingEdit : null);
    const shouldSaveWholeLayer = schemaDirtyDatasetId === datasetId || editToSave?.kind !== 'new';
    const result = editToSave?.kind === 'new' && !shouldSaveWholeLayer
      ? await addLayerFeature(datasetId, editToSave.feature)
      : await saveLayerFeatures(datasetId, applyPendingEdit(layer.features, editToSave), null);
    if (result) await finishStopEditing();
  };

  // Persist one layer's current GeoJSON features to PostGIS and refresh it from the server response.
  const saveLayerFeatures = async (datasetId, features, selectedFeatureToKeep = selectedFeatureId) => {
    if (!datasetId || !layersById[datasetId]) return null;

    setIsBusy(true);
    setAppStatus('Saving edits...');
    preserveCurrentMapView();
    try {
      const response = await apiFetch(`/datasets/${datasetId}/features`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          features: features.map(stripClientId),
        }),
      });

      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      const normalizedFeatures = normalizeFeatures(data.features);
      setLayersById((current) => ({
        ...current,
        [datasetId]: {
          ...current[datasetId],
          featureCount: data.features.length,
          features: normalizedFeatures,
          loaded: true,
        },
      }));
      const nextSelectedFeatureId = resolveSelectedAfterSave(normalizedFeatures, selectedFeatureToKeep);
      setSelectedFeatureId(nextSelectedFeatureId);
      setSelectedFeatureIds(nextSelectedFeatureId ? [nextSelectedFeatureId] : []);
      setSchemaDirtyDatasetId((current) => (current === datasetId ? null : current));
      setAppStatus(`Edits saved. ${data.features.length} features in layer.`);
      await loadDatasets();
      return data;
    } catch (error) {
      setAppStatus(error.message, 'error');
      return null;
    } finally {
      setIsBusy(false);
    }
  };

  // Persist one newly drawn feature without replacing all existing features in the layer.
  const addLayerFeature = async (datasetId, feature) => {
    if (!datasetId || !layersById[datasetId] || !feature) return null;

    setIsBusy(true);
    setAppStatus('Adding feature...');
    preserveCurrentMapView();
    try {
      const response = await apiFetch(`/datasets/${datasetId}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stripClientId(feature)),
      });

      if (response.status === 405) {
        throw new Error('Backend is still running an old build. Stop dotnet run, start it again, then save the feature.');
      }
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      const normalizedFeatures = normalizeFeatures(data.features);
      setLayersById((current) => ({
        ...current,
        [datasetId]: {
          ...current[datasetId],
          featureCount: data.features.length,
          features: normalizedFeatures,
          loaded: true,
        },
      }));
      setSelectedFeatureId(null);
      setSelectedFeatureIds([]);
      setPendingEdit(null);
      setSchemaDirtyDatasetId((current) => (current === datasetId ? null : current));
      setAppStatus(`Feature added. ${data.features.length} features in layer.`);
      await loadDatasets();
      return data;
    } catch (error) {
      setAppStatus(error.message, 'error');
      return null;
    } finally {
      setIsBusy(false);
    }
  };

  // Save the currently selected feature by syncing its whole shapefile layer.
  const saveSelectedFeature = async () => {
    if (!editingDatasetId || editingDatasetId !== activeDatasetId || !activeLayer) return;
    const editToSave = mergeLiveEditableFeature(editingDatasetId, pendingEdit?.datasetId === editingDatasetId ? pendingEdit : null);
    const shouldSaveWholeLayer = schemaDirtyDatasetId === editingDatasetId || editToSave?.kind !== 'new';
    const result = editToSave?.kind === 'new' && !shouldSaveWholeLayer
      ? await addLayerFeature(editingDatasetId, editToSave.feature)
      : await saveLayerFeatures(editingDatasetId, applyPendingEdit(activeLayer.features, editToSave), null);
    if (result) {
      setPendingEdit(null);
      setSelectedFeatureId(null);
      setSelectedFeatureIds([]);
    }
  };

  // Download the currently selected shapefile layer after server-side shapefile export.
  const downloadDataset = () => {
    if (!activeDatasetId) return;
    window.location.href = `${API_BASE}/datasets/${activeDatasetId}/download?sessionId=${encodeURIComponent(EDITING_SESSION_ID)}`;
  };

  // Update one attribute field on every selected feature while the panel shows the last selected feature.
  const updateFeatureProperties = (key, value) => {
    if (!activeDatasetId || !selectedFeature) return;

    if (editingDatasetId === activeDatasetId) {
      const targetFeatureIds = selectedFeatureIds.length > 0 ? selectedFeatureIds : [selectedFeatureId].filter(Boolean);
      setLayersById((current) => {
        const layer = current[activeDatasetId];
        if (!layer) return current;
        return {
          ...current,
          [activeDatasetId]: {
            ...layer,
            features: layer.features.map((feature) => (
              targetFeatureIds.includes(feature.clientId)
                ? { ...feature, properties: { ...(feature.properties ?? {}), [key]: value } }
                : feature
            )),
          },
        };
      });

      setPendingEdit((current) => {
        if (current?.datasetId !== activeDatasetId) return current;
        if (current?.datasetId === activeDatasetId && current.kind === 'split') {
          return {
            ...current,
            features: current.features.map((feature) =>
              targetFeatureIds.includes(feature.clientId)
                ? { ...feature, properties: { ...(feature.properties ?? {}), [key]: value } }
                : feature,
            ),
          };
        }
        if (!current?.feature || !targetFeatureIds.includes(current.feature.clientId)) return current;
        return {
          ...current,
          feature: {
            ...current.feature,
            properties: { ...(current.feature.properties ?? {}), [key]: value },
          },
        };
      });

      setSchemaDirtyDatasetId(activeDatasetId);
    }
  };

  // Add one attribute column to every feature in the active editing layer.
  const addLayerField = () => {
    if (!activeDatasetId || editingDatasetId !== activeDatasetId || !activeLayer) return;
    const fieldName = nextLayerFieldName(activeLayer.features);
    updateLayerFeatureProperties(activeDatasetId, (properties) => ({
      ...properties,
      [fieldName]: properties[fieldName] ?? '',
    }));
    setSchemaDirtyDatasetId(activeDatasetId);
    setAppStatus(`Field ${fieldName} added to layer. Click Save to persist.`);
  };

  // Rename an attribute column across the active editing layer, not just the selected feature.
  const renameLayerField = (oldKey, newKey) => {
    const cleanKey = newKey.trim();
    if (!activeDatasetId || editingDatasetId !== activeDatasetId || !activeLayer || oldKey === cleanKey || !cleanKey) return;
    if (layerHasField(activeLayer.features, cleanKey)) return;
    updateLayerFeatureProperties(activeDatasetId, (properties) => renamePropertyKey(properties, oldKey, cleanKey));
    setSchemaDirtyDatasetId(activeDatasetId);
    setAppStatus(`Field ${oldKey} renamed to ${cleanKey}. Click Save to persist.`);
  };

  // Remove an attribute column from every feature in the active editing layer.
  const removeLayerField = (key) => {
    if (!activeDatasetId || editingDatasetId !== activeDatasetId || !activeLayer) return;
    updateLayerFeatureProperties(activeDatasetId, (properties) => {
      const next = { ...properties };
      delete next[key];
      return next;
    });
    setSchemaDirtyDatasetId(activeDatasetId);
    setAppStatus(`Field ${key} removed from layer. Click Save to persist.`);
  };

  // Apply schema-level attribute changes to every feature and to any staged selected feature.
  const updateLayerFeatureProperties = (datasetId, updater) => {
    setLayersById((current) => {
      const layer = current[datasetId];
      if (!layer) return current;
      return {
        ...current,
        [datasetId]: {
          ...layer,
          features: layer.features.map((feature) => ({
            ...feature,
            properties: updater(feature.properties ?? {}),
          })),
        },
      };
    });

    setPendingEdit((current) => {
      if (current?.datasetId !== datasetId) return current;
      if (current.kind === 'split') {
        return {
          ...current,
          features: current.features.map((feature) => ({
            ...feature,
            properties: updater(feature.properties ?? {}),
          })),
        };
      }
      return {
        ...current,
        feature: {
          ...current.feature,
          properties: updater(current.feature.properties ?? {}),
        },
      };
    });
  };

  // Delete every selected feature through the API and refresh this layer from the database response.
  const removeSelectedFeature = async () => {
    if (!activeDatasetId || editingDatasetId !== activeDatasetId || selectedFeatureIds.length === 0) return;

    const selectedFeatures = selectedFeatureIds
      .map((featureId) => findLayerFeature(activeLayer?.features ?? [], featureId, pendingEdit))
      .filter(Boolean);
    if (selectedFeatures.length === 0) return;

    const savedFeatures = selectedFeatures.filter((feature) => feature.id);
    const unsavedClientIds = selectedFeatures
      .filter((feature) => !feature.id)
      .map((feature) => feature.clientId);

    if (unsavedClientIds.length > 0) {
      setPendingEdit((current) => removePendingFeatures(current, unsavedClientIds));
    }

    if (savedFeatures.length === 0) {
      setSelectedFeatureId(null);
      setSelectedFeatureIds([]);
      setAppStatus(`${unsavedClientIds.length} unsaved feature${unsavedClientIds.length === 1 ? '' : 's'} removed`);
      return;
    }

    setIsBusy(true);
    setAppStatus(`Deleting ${savedFeatures.length} feature${savedFeatures.length === 1 ? '' : 's'}...`);
    preserveCurrentMapView();
    try {
      let data = null;
      for (const feature of savedFeatures) {
        const response = await apiFetch(`/datasets/${activeDatasetId}/features/${feature.id}`, {
          method: 'DELETE',
        });

        if (!response.ok) throw new Error(await response.text());
        data = await response.json();
      }
      const normalizedFeatures = normalizeFeatures(data.features);
      setLayersById((current) => ({
        ...current,
        [activeDatasetId]: {
          ...current[activeDatasetId],
          featureCount: data.features.length,
          features: normalizedFeatures,
          loaded: true,
        },
      }));
      setPendingEdit(null);
      setSelectedFeatureId(null);
      setSelectedFeatureIds([]);
      setAppStatus(`${selectedFeatures.length} feature${selectedFeatures.length === 1 ? '' : 's'} deleted. ${data.features.length} features in layer.`);
      await loadDatasets();
    } catch (error) {
      setAppStatus(error.message, 'error');
    } finally {
      setIsBusy(false);
    }
  };

  // Select a feature from the map or table and optionally zoom to it.
  const selectFeature = (datasetId, featureId, shouldZoom = false, shouldToggle = false) => {
    setActiveDatasetId(datasetId);
    if (!featureId) {
      setSelectedFeatureId(null);
      setSelectedFeatureIds([]);
      return;
    }

    if (shouldToggle && datasetId === activeDatasetId) {
      setSelectedFeatureIds((current) => {
        const alreadySelected = current.includes(featureId);
        const nextSelection = alreadySelected
          ? current.filter((id) => id !== featureId)
          : [...current, featureId];
        setSelectedFeatureId(alreadySelected ? nextSelection[nextSelection.length - 1] ?? null : featureId);
        return nextSelection;
      });
    } else {
      setSelectedFeatureId(featureId);
      setSelectedFeatureIds([featureId]);
    }
    if (shouldZoom) {
      setZoomRequest({ datasetId, featureId, nonce: Date.now() });
    }
  };

  // Stage a newly drawn feature so the map can show it before the shapefile layer is saved.
  const stageCreatedFeature = (datasetId, feature) => {
    setPendingEdit({ datasetId, kind: 'new', feature });
    setSelectedFeatureId(feature.clientId);
    setSelectedFeatureIds([feature.clientId]);
    setAppStatus('New feature is pending. Fill attributes and click Save.');
  };

  // Stage geometry changes from Leaflet Draw instead of immediately changing the committed table rows.
  const stageUpdatedFeature = (datasetId, feature) => {
    setPendingEdit((current) => {
      if (current?.datasetId === datasetId && current.kind === 'split') {
        return {
          ...current,
          features: current.features.map((item) => (item.clientId === feature.clientId ? feature : item)),
        };
      }
      return {
        datasetId,
        kind: current?.datasetId === datasetId && current?.feature?.clientId === feature.clientId ? current.kind : 'update',
        feature,
      };
    });
    setSelectedFeatureId(feature.clientId);
    setSelectedFeatureIds([feature.clientId]);
    setAppStatus('Geometry edit is pending. Click Save to update the shapefile.');
  };

  // Stage polygon splits as removed source features plus new polygon pieces.
  const stageSplitFeature = (datasetId, removedClientIds, features) => {
    const removedIds = Array.isArray(removedClientIds) ? removedClientIds : [removedClientIds];
    setPendingEdit((current) => {
      if (current?.datasetId !== datasetId || current.kind !== 'split') {
        return { datasetId, kind: 'split', removedClientIds: removedIds, features };
      }

      return {
        ...current,
        removedClientIds: [...new Set([...current.removedClientIds, ...removedIds])],
        features: [
          ...current.features.filter((feature) => !removedIds.includes(feature.clientId)),
          ...features,
        ],
      };
    });
    setSelectedFeatureId(features[0]?.clientId ?? null);
    setSelectedFeatureIds(features.map((feature) => feature.clientId));
    setAppStatus(`${removedIds.length} polygon${removedIds.length === 1 ? '' : 's'} cut into ${features.length} separate features. Click Save to update the shapefile.`);
  };

  // Store a per-layer display color without touching the saved geometry.
  const updateLayerColor = (datasetId, color) => {
    preserveCurrentMapView();
    setLayersById((current) => ({
      ...current,
      [datasetId]: {
        ...current[datasetId],
        color,
      },
    }));
  };

  // Toggle whether a loaded shapefile layer is drawn on the map.
  const toggleLayerVisibility = async (datasetId) => {
    preserveCurrentMapView();
    const nextVisible = !(layersById[datasetId]?.visible ?? false);
    if (nextVisible && !layersById[datasetId]?.loaded) {
      await loadLayer(datasetId);
    }

    setLayersById((current) => ({
      ...current,
      [datasetId]: {
        ...current[datasetId],
        visible: nextVisible,
      },
    }));
    setActiveDatasetId(nextVisible ? datasetId : activeDatasetId === datasetId ? null : activeDatasetId);
    if (!nextVisible && activeDatasetId === datasetId) {
      setSelectedFeatureId(null);
      setSelectedFeatureIds([]);
    }
  };

  // Move a layer up or down in the render stack and left sidebar list.
  const moveLayer = (datasetId, direction) => {
    preserveCurrentMapView();
    setLayerOrder((current) => {
      const index = current.indexOf(datasetId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  // Zoom the map to the full extent of one visible layer.
  const zoomToLayer = async (datasetId) => {
    if (!layersById[datasetId]?.loaded) {
      await loadLayer(datasetId);
    }
    setLayersById((current) => ({
      ...current,
      [datasetId]: {
        ...current[datasetId],
        visible: true,
      },
    }));
    setActiveDatasetId(datasetId);
    setLayerZoomRequest({ datasetId, nonce: Date.now() });
  };

  // Clear the selected feature without changing layer visibility.
  const clearLayerSelection = (datasetId) => {
    preserveCurrentMapView();
    if (activeDatasetId === datasetId) {
      setSelectedFeatureId(null);
      setSelectedFeatureIds([]);
      setAppStatus('Selection cleared');
    }
  };

  // Delete one layer from PostGIS and remove it from all browser-side editor state.
  const deleteLayer = async (datasetId) => {
    setIsBusy(true);
    setAppStatus('Deleting layer...');
    preserveCurrentMapView();
    try {
      const response = await apiFetch(`/datasets/${datasetId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || 'Could not delete layer. Restart the backend if this endpoint was just added.');
      }

      setDatasets((current) => current.filter((dataset) => dataset.id !== datasetId));
      setLayerOrder((current) => current.filter((id) => id !== datasetId));
      setLayersById((current) => {
        const next = { ...current };
        delete next[datasetId];
        return next;
      });
      if (activeDatasetId === datasetId) setActiveDatasetId(null);
      if (editingDatasetId === datasetId) setEditingDatasetId(null);
      setSelectedFeatureId(null);
      setSelectedFeatureIds([]);
      setAppStatus('Layer deleted');
    } catch (error) {
      setAppStatus(error.message, 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const orderedDatasets = useMemo(
    () => layerOrder
      .map((id) => datasets.find((dataset) => dataset.id === id))
      .filter(Boolean),
    [datasets, layerOrder],
  );

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Layers size={24} aria-hidden="true" />
          <div>
            <h1>GIS Editing App</h1>
          </div>
        </div>

        <form className="upload-panel" onSubmit={uploadDataset}>
          <label htmlFor="shapefile">Upload vector data (.zip, .geojson, .json, .kml, .kmz)</label>
          <input
            id="shapefile"
            ref={uploadInputRef}
            type="file"
            accept=".zip,.geojson,.json,.kml,.kmz"
            onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
          />
          <button type="submit" disabled={!uploadFile || isBusy}>
            <UploadCloud size={18} aria-hidden="true" />
            Upload
          </button>
        </form>

        <section className="dataset-list" aria-label="Shapefile layers">
          {orderedDatasets.map((dataset, index) => {
            const layer = layersById[dataset.id] ?? emptyLayer(dataset, 0);
            const isActive = activeDatasetId === dataset.id;
            const isEditing = editingDatasetId === dataset.id;
            return (
              <article className={`layer-item ${isActive ? 'active' : ''}`} key={dataset.id}>
                <button
                  type="button"
                  className="layer-open"
                  onClick={() => {
                    preserveCurrentMapView();
                    loadLayer(dataset.id, { activate: layer.visible });
                  }}
                >
                  <span>{dataset.name}</span>
                  <small>{dataset.geometryType} | {layer.featureCount ?? dataset.featureCount} features</small>
                </button>
                <div className="layer-actions">
                  <button type="button" onClick={() => startEditing(dataset.id)} disabled={isBusy || isEditing} title="Start editing">
                    <SquarePen size={16} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={stopEditing} disabled={!isEditing} title="Stop editing">
                    <SquareX size={16} aria-hidden="true" />
                  </button>
                  <label className="color-control" title="Change layer color">
                    <input type="color" value={layer.color} onChange={(event) => updateLayerColor(dataset.id, event.target.value)} />
                  </label>
                  <button type="button" onClick={() => toggleLayerVisibility(dataset.id)} disabled={isBusy} title={layer.visible ? 'Hide layer' : 'Show layer'}>
                    {layer.visible ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
                  </button>
                  <button type="button" onClick={() => moveLayer(dataset.id, -1)} disabled={index === 0} title="Move layer up">
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => moveLayer(dataset.id, 1)} disabled={index === orderedDatasets.length - 1} title="Move layer down">
                    <ArrowDown size={16} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => zoomToLayer(dataset.id)} disabled={isBusy} title="Zoom to layer">
                    <LocateFixed size={16} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => clearLayerSelection(dataset.id)} disabled={activeDatasetId !== dataset.id || selectedFeatureIds.length === 0} title="Clear selection">
                    <MousePointer2 size={16} aria-hidden="true" />
                  </button>
                  <button type="button" className="delete-layer" onClick={() => deleteLayer(dataset.id)} disabled={isBusy} title="Delete layer">
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      </aside>

      <section
        className={`workspace ${attributeTableResizing ? 'resizing' : ''}`}
        style={{ '--attribute-table-height': `${tableRowHeight}px` }}
      >
        <header className="topbar">
          <div>
            <strong>{activeLayer?.name ?? 'No visible shapefile selected'}</strong>
            <span className={`status ${statusKind}`}>
              {editingDatasetId && statusKind !== 'error' ? `Editing active layer only | ${status}` : status}
            </span>
          </div>
          <nav>
            <button type="button" onClick={downloadDataset} disabled={!activeDatasetId || isBusy}>
              <Download size={18} aria-hidden="true" />
              Download
            </button>
          </nav>
        </header>

        <div className="editor-grid">
          <MapEditor
            layersById={layersById}
            layerOrder={layerOrder}
            activeDatasetId={activeDatasetId}
            editingDatasetId={editingDatasetId}
            selectedFeatureId={selectedFeatureId}
            selectedFeatureIds={selectedFeatureIds}
            zoomRequest={zoomRequest}
            layerZoomRequest={layerZoomRequest}
            pendingEdit={pendingEdit}
            onSelect={selectFeature}
            onPendingCreate={stageCreatedFeature}
            onPendingUpdate={stageUpdatedFeature}
            onPendingSplit={stageSplitFeature}
            onDeleteSelected={removeSelectedFeature}
            onRegisterPreserveMapView={(capture) => {
              preserveMapViewRef.current = capture;
            }}
            onRegisterFlushEditableFeature={(flush) => {
              flushEditableFeatureRef.current = flush;
            }}
          />
        </div>

        <AttributePanel
          feature={selectedFeature}
          selectedFeatureCount={selectedFeatureIds.length}
          canEdit={Boolean(activeDatasetId && editingDatasetId === activeDatasetId)}
          isBusy={isBusy}
          onChange={updateFeatureProperties}
          onAddField={addLayerField}
          onRenameField={renameLayerField}
          onRemoveField={removeLayerField}
          onSave={saveSelectedFeature}
          onDelete={removeSelectedFeature}
        />

        <BottomBarHandle
          isCollapsed={attributeTableCollapsed}
          onToggleCollapse={() => setAttributeTableCollapsed((current) => !current)}
          onResize={(nextHeight) => {
            setAttributeTableCollapsed(false);
            setAttributeTableHeight(clamp(nextHeight, 120, 520));
          }}
          onResizeStart={() => setAttributeTableResizing(true)}
          onResizeEnd={() => setAttributeTableResizing(false)}
        />

        <AttributeTable
          layer={activeLayer}
          selectedFeatureId={selectedFeatureId}
          selectedFeatureIds={selectedFeatureIds}
          isCollapsed={attributeTableCollapsed}
          onRowClick={(featureId, shouldToggle) => activeDatasetId && selectFeature(activeDatasetId, featureId, !shouldToggle, shouldToggle)}
        />
      </section>
      {stopEditingPrompt && (
        <StopEditingDialog
          layerName={layersById[stopEditingPrompt.datasetId]?.name ?? 'current layer'}
          nextLayerName={stopEditingPrompt.nextDatasetId ? layersById[stopEditingPrompt.nextDatasetId]?.name : null}
          isBusy={isBusy}
          onSave={saveAndStopEditing}
          onDiscard={finishStopEditing}
          onCancel={() => setStopEditingPrompt(null)}
        />
      )}
      {showWelcome && <WelcomeDialog onClose={closeWelcome} />}
    </main>
  );
}

// Store a concise top-bar message and whether it should render as normal info or an error.
function setAppStatusFactory(setStatus, setStatusKind) {
  return (message, kind = 'info') => {
    setStatus(shortenStatus(message));
    setStatusKind(kind);
  };
}

// Convert raw API/upload failures into short user-facing top-bar messages.
function formatUploadError(message) {
  const cleanMessage = stripHtml(message).trim();
  const featureLimitMatch = cleanMessage.match(/([^\r\n.]+\.shp) has (\d+) features/i);
  if (featureLimitMatch) {
    return `${featureLimitMatch[1]} has ${featureLimitMatch[2]} features. Upload shapefiles with 1000 features or fewer.`;
  }
  return shortenStatus(cleanMessage || 'Upload failed. Check that the ZIP contains valid shapefile files.');
}

// Keep the status bar readable even when the server returns a long development error.
function shortenStatus(message) {
  const cleanMessage = stripHtml(String(message ?? '')).replace(/\s+/g, ' ').trim();
  if (!cleanMessage) return 'Something went wrong.';
  return cleanMessage.length > 150 ? `${cleanMessage.slice(0, 147)}...` : cleanMessage;
}

// Remove HTML from ASP.NET error pages before showing a message in the top bar.
function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ');
}

// Attach the browser's editing session id to every API request that can read or change layers.
function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-GIS-Editing-Session', EDITING_SESSION_ID);
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

// Persist one local session id so one browser sees its own uploaded/editing layers after refresh.
function getEditingSessionId() {
  const key = 'gis-editing-session-id';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const sessionId = crypto.randomUUID();
  window.localStorage.setItem(key, sessionId);
  return sessionId;
}

// MapEditor keeps Leaflet's mutable layer objects isolated from React state.
// Only the selected feature is placed into the Leaflet Draw editable group to avoid freezing large shapefiles.
function MapEditor({
  layersById,
  layerOrder,
  activeDatasetId,
  editingDatasetId,
  selectedFeatureId,
  selectedFeatureIds,
  zoomRequest,
  layerZoomRequest,
  pendingEdit,
  onSelect,
  onPendingCreate,
  onPendingUpdate,
  onPendingSplit,
  onDeleteSelected,
  onRegisterPreserveMapView,
  onRegisterFlushEditableFeature,
}) {
  const mapRef = useRef(null);
  const viewGroupRef = useRef(null);
  const editGroupRef = useRef(null);
  const drawControlRef = useRef(null);
  const pointCreateControlRef = useRef(null);
  const deleteControlRef = useRef(null);
  const polygonAdvancedControlRef = useRef(null);
  const moveControlRef = useRef(null);
  const moveStateRef = useRef({ active: false });
  const polygonToolModeRef = useRef(null);
  const activeCustomDrawRef = useRef(null);
  const baseLayerRef = useRef(null);
  const currentBasemapRef = useRef('streets');
  const lastViewRef = useRef(null);
  const forcedViewRef = useRef(null);
  const viewHistoryRef = useRef([]);
  const skipViewHistoryRef = useRef(false);
  const previousExtentButtonRef = useRef(null);
  const handledZoomRequestRef = useRef(null);
  const handledLayerZoomRequestRef = useRef(null);
  const latestRef = useRef({
    editingDatasetId,
    selectedFeatureId,
    selectedFeatureIds,
    layersById,
    pendingEdit,
    onPendingCreate,
    onPendingUpdate,
    onPendingSplit,
    onDeleteSelected,
  });

  latestRef.current = {
    editingDatasetId,
    selectedFeatureId,
    selectedFeatureIds,
    layersById,
    pendingEdit,
    onPendingCreate,
    onPendingUpdate,
    onPendingSplit,
    onDeleteSelected,
  };

  // Let Save read the live selected editable geometry before it sends data to the backend.
  useEffect(() => {
    onRegisterFlushEditableFeature(() => {
      const editGroup = editGroupRef.current;
      if (!editGroup) return null;
      return readFeaturesFromLayerGroup(editGroup)[0] ?? null;
    });
    return () => onRegisterFlushEditableFeature(() => null);
  }, [onRegisterFlushEditableFeature]);

  // Create the Leaflet map, base tiles, and two layer groups: view-only and selected-edit.
  useEffect(() => {
    if (mapRef.current) return;

    const map = L.map('map', { zoomControl: false }).setView(INITIAL_MAP_CENTER, INITIAL_MAP_ZOOM);
    mapRef.current = map;
    lastViewRef.current = { center: map.getCenter(), zoom: map.getZoom() };
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

    const basemaps = {
      streets: {
        label: 'OpenStreetMap',
        thumb: 'https://a.tile.openstreetmap.org/6/44/25.png',
        layer: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 20,
          attribution: '&copy; OpenStreetMap contributors',
        }),
      },
      light: {
        label: 'Light Map',
        thumb: 'https://a.basemaps.cartocdn.com/light_all/6/44/25.png',
        layer: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 20,
          attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        }),
      },
      topo: {
        label: 'Topographic',
        thumb: 'https://a.tile.opentopomap.org/6/44/25.png',
        layer: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
          maxZoom: 17,
          attribution: '&copy; OpenStreetMap contributors &copy; OpenTopoMap',
        }),
      },
      imagery: {
        label: 'Imagery',
        thumb: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/6/25/44',
        layer: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19,
          attribution: 'Tiles &copy; Esri',
        }),
      },
      dark: {
        label: 'Dark Canvas',
        thumb: 'https://a.basemaps.cartocdn.com/dark_all/6/44/25.png',
        layer: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 20,
          attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        }),
      },
    };
    baseLayerRef.current = basemaps.streets.layer;
    baseLayerRef.current.addTo(map);
    createPreviousExtentControl(map, viewHistoryRef, lastViewRef, skipViewHistoryRef, previousExtentButtonRef).addTo(map);
    createHomeControl(map).addTo(map);
    createBasemapGalleryControl(map, basemaps, baseLayerRef, currentBasemapRef).addTo(map);

    const viewGroup = new L.FeatureGroup();
    const editGroup = new L.FeatureGroup();
    viewGroupRef.current = viewGroup;
    editGroupRef.current = editGroup;
    map.addLayer(viewGroup);
    map.addLayer(editGroup);

    map.on('moveend', () => {
      const nextView = { center: map.getCenter(), zoom: map.getZoom() };
      if (skipViewHistoryRef.current) {
        skipViewHistoryRef.current = false;
        lastViewRef.current = nextView;
        return;
      }

      if (lastViewRef.current && !sameMapView(lastViewRef.current, nextView)) {
        viewHistoryRef.current = [...viewHistoryRef.current.slice(-24), lastViewRef.current];
      }
      lastViewRef.current = nextView;
      if (previousExtentButtonRef.current) {
        previousExtentButtonRef.current.disabled = viewHistoryRef.current.length === 0;
      }
    });

    onRegisterPreserveMapView(() => {
      forcedViewRef.current = currentMapView(map);
    });

    map.on(L.Draw.Event.CREATED, (event) => {
      const datasetId = latestRef.current.editingDatasetId;
      if (!datasetId) return;
      const layer = event.layer;
      const feature = layer.toGeoJSON();

      if (polygonToolModeRef.current === 'autoComplete') {
        polygonToolModeRef.current = null;
        activeCustomDrawRef.current = null;
        const completedFeature = autoCompletePolygonFeature(
          feature,
          latestRef.current.layersById[datasetId]?.features ?? [],
        );
        if (!completedFeature) return;
        completedFeature.clientId = crypto.randomUUID();
        completedFeature.id = null;
        completedFeature.properties = createEmptyProperties(latestRef.current.layersById[datasetId]?.features ?? []);
        latestRef.current.onPendingCreate(datasetId, completedFeature);
        onSelect(datasetId, completedFeature.clientId);
        return;
      }

      if (polygonToolModeRef.current === 'cut') {
        polygonToolModeRef.current = null;
        activeCustomDrawRef.current = null;
        const selectedFeatureIdsForCut = latestRef.current.selectedFeatureIds?.length
          ? latestRef.current.selectedFeatureIds
          : [latestRef.current.selectedFeatureId].filter(Boolean);
        const layerFeatures = latestRef.current.layersById[datasetId]?.features ?? [];
        const cutResults = selectedFeatureIdsForCut
          .map((featureId) => findLayerFeature(layerFeatures, featureId, latestRef.current.pendingEdit))
          .filter(isPolygonFeature)
          .map((selectedFeature) => ({
            removedClientId: selectedFeature.clientId,
            features: cutSelectedPolygonFeatures(selectedFeature, feature),
          }))
          .filter((result) => result.features.length > 0);
        if (!cutResults.length) return;
        const removedClientIds = cutResults.map((result) => result.removedClientId);
        const cutFeatures = cutResults.flatMap((result) => result.features);
        latestRef.current.onPendingSplit(datasetId, removedClientIds, cutFeatures);
        onSelect(datasetId, cutFeatures[0].clientId);
        return;
      }

      feature.clientId = crypto.randomUUID();
      feature.id = null;
      feature.properties = createEmptyProperties(latestRef.current.layersById[datasetId]?.features ?? []);
      layer.feature = feature;
      editGroup.addLayer(layer);
      latestRef.current.onPendingCreate(datasetId, feature);
      onSelect(datasetId, feature.clientId);
    });

    map.on(L.Draw.Event.EDITED, () => {
      const datasetId = latestRef.current.editingDatasetId;
      if (!datasetId) return;
      const editedFeature = readFeaturesFromLayerGroup(editGroup)[0];
      if (editedFeature) latestRef.current.onPendingUpdate(datasetId, editedFeature);
    });

    map.on(L.Draw.Event.DELETED, () => {
      onSelect(latestRef.current.editingDatasetId, null);
    });

    map.on(L.Draw.Event.DRAWSTOP, () => {
      polygonToolModeRef.current = null;
      activeCustomDrawRef.current = null;
    });
  }, [onRegisterPreserveMapView, onSelect]);

  // Show the draw toolbar only while a shapefile layer is in editing mode.
  useEffect(() => {
    const map = mapRef.current;
    const editGroup = editGroupRef.current;
    if (!map || !editGroup) return;

    if (drawControlRef.current) {
      map.removeControl(drawControlRef.current);
      drawControlRef.current = null;
    }
    if (deleteControlRef.current) {
      map.removeControl(deleteControlRef.current);
      deleteControlRef.current = null;
    }
    if (pointCreateControlRef.current) {
      map.removeControl(pointCreateControlRef.current);
      pointCreateControlRef.current = null;
    }
    if (polygonAdvancedControlRef.current) {
      map.removeControl(polygonAdvancedControlRef.current);
      polygonAdvancedControlRef.current = null;
    }
    if (moveControlRef.current) {
      deactivateMoveFeature(map, moveStateRef);
      map.removeControl(moveControlRef.current);
      moveControlRef.current = null;
    }
    if (activeCustomDrawRef.current) {
      activeCustomDrawRef.current.disable();
      activeCustomDrawRef.current = null;
    }

    if (!editingDatasetId) return;

    const editingLayer = layersById[editingDatasetId];
    const editingFamily = geometryFamily(editingLayer?.geometryType);
    if (editingFamily === 'point') {
      const pointCreateControl = createPointCreateControl(map, activeCustomDrawRef);
      pointCreateControlRef.current = pointCreateControl;
      pointCreateControl.addTo(map);
    } else {
      const drawControl = new L.Control.Draw({
        position: 'topleft',
        draw: drawOptionsForGeometry(editingLayer?.geometryType),
        edit: {
          featureGroup: editGroup,
          remove: false,
        },
      });
      drawControlRef.current = drawControl;
      map.addControl(drawControl);
    }

    if (editingFamily === 'polygon') {
      const polygonAdvancedControl = createPolygonAdvancedControl(map, latestRef, polygonToolModeRef, activeCustomDrawRef);
      polygonAdvancedControlRef.current = polygonAdvancedControl;
      polygonAdvancedControl.addTo(map);
    }

    if (['point', 'line', 'polygon'].includes(editingFamily)) {
      const moveControl = createMoveSelectedControl(map, editGroup, latestRef, moveStateRef);
      moveControlRef.current = moveControl;
      moveControl.addTo(map);
    }

    const deleteControl = createDeleteSelectedControl(latestRef);
    deleteControlRef.current = deleteControl;
    deleteControl.addTo(map);
  }, [editingDatasetId, layersById]);

  // Keep custom move/delete buttons enabled only when an editable feature is selected.
  useEffect(() => {
    const deleteButton = deleteControlRef.current?.getContainer()?.querySelector('button');
    if (deleteButton) {
      deleteButton.disabled = !(editingDatasetId && selectedFeatureIds.length > 0);
      deleteButton.title = selectedFeatureIds.length > 0 ? 'Delete selected feature' : 'Select a feature to delete';
    }

    const moveButton = moveControlRef.current?.getContainer()?.querySelector('button');
    if (moveButton) {
      const family = geometryFamily(layersById[editingDatasetId]?.geometryType);
      moveButton.disabled = !(editingDatasetId && selectedFeatureId && ['point', 'line', 'polygon'].includes(family));
      moveButton.title = selectedFeatureId ? 'Move selected feature' : 'Select a feature to move';
    }
  }, [editingDatasetId, selectedFeatureId, selectedFeatureIds, layersById]);

  // Render loaded layers. The selected feature from the editing layer is the only editable Leaflet layer.
  useEffect(() => {
    const map = mapRef.current;
    const viewGroup = viewGroupRef.current;
    const editGroup = editGroupRef.current;
    if (!map || !viewGroup || !editGroup) return;

    const previousView = forcedViewRef.current ?? currentMapView(map);
    viewGroup.clearLayers();
    editGroup.clearLayers();

    layerOrder.forEach((layerId) => {
      const layer = layersById[layerId];
      if (!layer?.loaded || !layer.visible) return;
      layer.features.forEach((feature) => {
        if (pendingEdit?.datasetId === layer.id && pendingEdit.kind === 'split' && pendingEdit.removedClientIds.includes(feature.clientId)) return;
        const pendingFeatureMatches = pendingEdit?.datasetId === layer.id && pendingEdit.feature?.clientId === feature.clientId;
        const featureToRender = pendingFeatureMatches ? pendingEdit.feature : feature;
        const isSelected = selectedFeatureIds.includes(featureToRender.clientId);
        const isSelectedEditableFeature = layer.id === editingDatasetId && featureToRender.clientId === selectedFeatureId;
        const targetGroup = isSelectedEditableFeature ? editGroup : viewGroup;
        const geoLayer = L.geoJSON(featureToRender, {
          style: () => featureStyle(layer.color, isSelected, layer.id === activeDatasetId),
          pointToLayer: (_, latlng) => L.circleMarker(latlng, pointStyle(layer.color, isSelected)),
          onEachFeature: (_, childLayer) => {
            childLayer.feature = featureToRender;
            childLayer.on('click', (event) => onSelect(layer.id, featureToRender.clientId, false, isToggleSelectionEvent(event)));
          },
        });
        geoLayer.eachLayer((child) => targetGroup.addLayer(child));
      });
    });

    if (pendingEdit?.kind === 'new') {
      const layer = layersById[pendingEdit.datasetId];
      if (layer?.loaded && layer.visible) {
        const geoLayer = L.geoJSON(pendingEdit.feature, {
          style: () => featureStyle(layer.color, true, true),
          pointToLayer: (_, latlng) => L.circleMarker(latlng, pointStyle(layer.color, true)),
          onEachFeature: (_, childLayer) => {
            childLayer.feature = pendingEdit.feature;
            childLayer.on('click', (event) => onSelect(layer.id, pendingEdit.feature.clientId, false, isToggleSelectionEvent(event)));
          },
        });
        geoLayer.eachLayer((child) => editGroup.addLayer(child));
      }
    }

    if (pendingEdit?.kind === 'split') {
      const layer = layersById[pendingEdit.datasetId];
      if (layer?.loaded && layer.visible) {
        pendingEdit.features.forEach((feature) => {
          const isSelected = selectedFeatureIds.includes(feature.clientId);
          const geoLayer = L.geoJSON(feature, {
            style: () => featureStyle(layer.color, isSelected, true),
            onEachFeature: (_, childLayer) => {
              childLayer.feature = feature;
              childLayer.on('click', (event) => onSelect(layer.id, feature.clientId, false, isToggleSelectionEvent(event)));
            },
          });
          geoLayer.eachLayer((child) => (feature.clientId === selectedFeatureId ? editGroup : viewGroup).addLayer(child));
        });
      }
    }

    // Preserve the user's current map view while layers are loaded, toggled, edited, or refreshed.
    // Explicit commands such as "Zoom to layer" and table-row selection still move the map.
    if (previousView) {
      restoreMapView(map, previousView, skipViewHistoryRef);
      forcedViewRef.current = null;
    }
  }, [layersById, layerOrder, activeDatasetId, editingDatasetId, selectedFeatureId, selectedFeatureIds, pendingEdit, onSelect]);

  // Zoom to a row-selected feature from the bottom attribute table.
  useEffect(() => {
    if (!zoomRequest) return;
    if (handledZoomRequestRef.current === zoomRequest.nonce) return;
    const map = mapRef.current;
    if (!map) return;

    const layer = layersById[zoomRequest.datasetId];
    const feature = layer?.features.find((item) => item.clientId === zoomRequest.featureId);
    if (!feature) return;

    handledZoomRequestRef.current = zoomRequest.nonce;
    const geoLayer = L.geoJSON(feature);
    const bounds = geoLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.35), { maxZoom: 18 });
    }
  }, [zoomRequest, layersById]);

  // Zoom to an entire layer from the left-side layer controls.
  useEffect(() => {
    if (!layerZoomRequest) return;
    if (handledLayerZoomRequestRef.current === layerZoomRequest.nonce) return;
    const map = mapRef.current;
    if (!map) return;

    const layer = layersById[layerZoomRequest.datasetId];
    if (!layer?.loaded || layer.features.length === 0) return;

    handledLayerZoomRequestRef.current = layerZoomRequest.nonce;
    const bounds = L.geoJSON({
      type: 'FeatureCollection',
      features: layer.features,
    }).getBounds();

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.18));
    }
  }, [layerZoomRequest, layersById]);

  return <div id="map" className="map" aria-label="Map editor" />;
}

// StopEditingDialog forces the user to decide whether edits should be saved before editing turns off or switches layers.
function StopEditingDialog({ layerName, nextLayerName, isBusy, onSave, onDiscard, onCancel }) {
  const isSwitching = Boolean(nextLayerName);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="stop-editing-title">
        <h2 id="stop-editing-title">{isSwitching ? 'Switch editing layer?' : 'Stop editing?'}</h2>
        <p>
          {isSwitching
            ? `Save edits for ${layerName} before editing ${nextLayerName}?`
            : `Save edits for ${layerName} before leaving editing mode?`}
        </p>
        <div className="confirm-actions">
          <button type="button" className="save-feature" onClick={onSave} disabled={isBusy}>Save</button>
          <button type="button" className="discard-editing" onClick={onDiscard} disabled={isBusy}>Discard</button>
          <button type="button" onClick={onCancel} disabled={isBusy}>Cancel</button>
        </div>
      </section>
    </div>
  );
}

// WelcomeDialog explains the editor workflow the first time a user opens the app.
function WelcomeDialog({ onClose }) {
  return (
    <div className="modal-backdrop welcome-backdrop" role="presentation">
      <section className="welcome-dialog" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <button type="button" className="welcome-close" onClick={onClose} aria-label="Close welcome window">x</button>
        <h2 id="welcome-title">GIS Editing App</h2>
        <p>
          Upload shapefile ZIPs, GeoJSON, KML, or KMZ files, inspect their geometry and attributes, edit vector features, then download the updated data in the same format.
        </p>
        <div className="welcome-grid">
          <article>
            <strong>1. Upload layers</strong>
            <span>Choose a shapefile ZIP, GeoJSON, KML, or KMZ file. Each imported dataset appears as a layer in the left panel.</span>
          </article>
          <article>
            <strong>2. Turn on visibility</strong>
            <span>Use the eye button to show a layer. The map, right attribute panel, and bottom table stay connected.</span>
          </article>
          <article>
            <strong>3. Start editing</strong>
            <span>Click the edit button for one layer. Other layers remain view-only while the active layer is edited.</span>
          </article>
          <article>
            <strong>4. Save and download</strong>
            <span>Draw, move, cut, delete, or update attributes. Click Save, then Download to export in the uploaded format.</span>
          </article>
        </div>
        <button type="button" className="welcome-primary" onClick={onClose}>Start editing</button>
      </section>
    </div>
  );
}

// AttributePanel shows the selected feature's properties and only unlocks inputs during edit mode.
function AttributePanel({ feature, selectedFeatureCount, canEdit, isBusy, onChange, onAddField, onRenameField, onRemoveField, onSave, onDelete }) {
  const properties = feature?.properties ?? {};
  const [fieldToRemove, setFieldToRemove] = useState(null);

  // Write an edited attribute value into every selected feature.
  const updateValue = (key, value) => onChange(key, value);

  // Ask the layer-level schema handler to remove this column from every feature.
  const removeField = (key) => {
    onRemoveField(key);
    setFieldToRemove(null);
  };

  if (!feature) {
    return (
      <aside className={`attribute-panel empty ${canEdit ? 'editing' : ''}`}>
        <div className="panel-header">
          <h2>Attribute</h2>
          {canEdit && (
            <div className="panel-actions two-option">
              <button type="button" className="save-feature" onClick={onSave} disabled={isBusy}>
                <Save size={16} aria-hidden="true" />
                Save
              </button>
              <button type="button" className="delete-feature" onClick={onDelete} disabled={isBusy} title="Delete selected feature">
                Delete
              </button>
            </div>
          )}
        </div>
        <p>Select a map feature or an attribute table row.</p>
      </aside>
    );
  }

  return (
    <aside className="attribute-panel">
      <div className="panel-header">
        <h2>Attribute</h2>
        {selectedFeatureCount > 1 && (
          <p className="selection-note">
            {selectedFeatureCount} features selected. Showing last selected feature attributes; edits apply to all selected features.
          </p>
        )}
        {canEdit && (
          <div className="panel-actions">
            <button type="button" className="save-feature" onClick={onSave} disabled={isBusy}>
              <Save size={16} aria-hidden="true" />
              Save
            </button>
            <button type="button" className="delete-feature" onClick={onDelete} disabled={isBusy} title="Delete selected feature">
              Delete
            </button>
            <button
              type="button"
              className="add-field compact"
              disabled={isBusy}
              onClick={onAddField}
            >
              Add field
            </button>
          </div>
        )}
      </div>
      <div className="field-list">
        {Object.entries(properties).map(([key, value], index) => (
          <div className="field-row" key={index}>
            <input
              defaultValue={key}
              disabled={!canEdit}
              onBlur={(event) => onRenameField(key, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              aria-label="Field name"
            />
            <input value={value ?? ''} disabled={!canEdit} onChange={(event) => updateValue(key, event.target.value)} aria-label="Field value" />
            <button type="button" onClick={() => setFieldToRemove(key)} disabled={!canEdit} title="Remove field">x</button>
          </div>
        ))}
      </div>
      {fieldToRemove !== null && (
        <ConfirmRemoveFieldDialog
          fieldName={fieldToRemove}
          onConfirm={() => removeField(fieldToRemove)}
          onCancel={() => setFieldToRemove(null)}
        />
      )}
    </aside>
  );
}

// Confirm field removal because deleting an attribute column changes the selected feature immediately.
function ConfirmRemoveFieldDialog({ fieldName, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-field-title">
        <h2 id="remove-field-title">Remove field?</h2>
        <p>{`Remove "${fieldName}" from this feature's attributes?`}</p>
        <div className="confirm-actions two-option">
          <button type="button" className="delete-feature" onClick={onConfirm}>Yes</button>
          <button type="button" onClick={onCancel}>No</button>
        </div>
      </section>
    </div>
  );
}

// BottomBarHandle overlays the map/table boundary and controls collapse plus drag resizing.
function BottomBarHandle({ isCollapsed, onToggleCollapse, onResize, onResizeStart, onResizeEnd }) {
  // Dragging the top boundary resizes the bottom attribute table without changing map data.
  const startResize = (event) => {
    event.preventDefault();
    onResizeStart();
    const startY = event.clientY;
    const startHeight = Number.parseFloat(getComputedStyle(document.querySelector('.workspace')).getPropertyValue('--attribute-table-height')) || 230;

    const move = (moveEvent) => {
      onResize(startHeight + startY - moveEvent.clientY);
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      onResizeEnd();
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };

  return (
    <div className="table-resize-edge" onMouseDown={startResize} role="separator" aria-orientation="horizontal">
      <button
        type="button"
        className="table-toggle"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={onToggleCollapse}
        title={isCollapsed ? 'Expand attribute table' : 'Collapse attribute table'}
      >
        {isCollapsed ? <ChevronsUp size={16} aria-hidden="true" /> : <ChevronsDown size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}

// AttributeTable mirrors the loaded shapefile attribute table and drives map selection/zoom.
function AttributeTable({ layer, selectedFeatureId, selectedFeatureIds, isCollapsed, onRowClick }) {
  const rowRefs = useRef({});
  const fields = useMemo(() => {
    const names = new Set();
    layer?.features.forEach((feature) => {
      Object.keys(feature.properties ?? {}).forEach((key) => names.add(key));
    });
    return [...names];
  }, [layer]);
  const orderedFeatures = useMemo(() => {
    if (!layer) return [];
    if (selectedFeatureIds.length === 0) return layer.features;
    const selectedIds = new Set(selectedFeatureIds);
    return [
      ...layer.features.filter((feature) => selectedIds.has(feature.clientId)),
      ...layer.features.filter((feature) => !selectedIds.has(feature.clientId)),
    ];
  }, [layer, selectedFeatureIds]);

  // Keep the selected map feature visible in the bottom table.
  useEffect(() => {
    if (selectedFeatureId && rowRefs.current[selectedFeatureId]) {
      rowRefs.current[selectedFeatureId].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [selectedFeatureId]);

  return (
    <section className={`attribute-table ${isCollapsed ? 'collapsed' : ''}`} aria-label="Attribute table">
      <header>
        <strong>{layer?.name ?? 'Attribute table'}</strong>
        <span>{selectedFeatureIds.length} selected out of {layer?.features.length ?? 0} rows</span>
      </header>
      <div className="table-scroll">
        {!layer ? (
          <div className="table-empty">No visible layer. Turn on a layer with the eye button to view its attributes.</div>
        ) : layer.features.length === 0 ? (
          <div className="table-empty">This visible layer has no features.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>No.</th>
                {fields.map((field) => <th key={field}>{field}</th>)}
              </tr>
            </thead>
            <tbody>
              {orderedFeatures.map((feature, index) => (
                <tr
                  ref={(node) => {
                    if (node) rowRefs.current[feature.clientId] = node;
                  }}
                  key={feature.clientId}
                  className={selectedFeatureIds.includes(feature.clientId) ? 'selected' : ''}
                  onClick={(event) => onRowClick(feature.clientId, event.ctrlKey || event.shiftKey)}
                >
                  <td>{index + 1}</td>
                  {fields.map((field) => <td key={field}>{formatCell(feature.properties?.[field])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

// Build a placeholder layer before its GeoJSON features are requested from the API.
function emptyLayer(dataset, index) {
  return {
    ...dataset,
    color: palette[index % palette.length],
    visible: false,
    loaded: false,
    features: [],
  };
}

// Read a layer visibility flag safely while a layer may still be only a placeholder.
function currentLayerVisible(id, layersById) {
  return Boolean(layersById[id]?.visible);
}

// Keep the user's layer order while appending newly uploaded/server-discovered layers.
function mergeLayerOrder(currentOrder, datasetIds) {
  const knownIds = new Set(datasetIds);
  return [
    ...currentOrder.filter((id) => knownIds.has(id)),
    ...datasetIds.filter((id) => !currentOrder.includes(id)),
  ];
}

// Keep user-resized panel dimensions inside practical desktop limits.
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

// Apply one staged feature edit only when the user explicitly presses Save.
function applyPendingEdit(features, pendingEdit) {
  if (!pendingEdit) return features;
  if (pendingEdit.kind === 'new') return [...features, pendingEdit.feature];
  if (pendingEdit.kind === 'split') {
    return [
      ...features.filter((feature) => !pendingEdit.removedClientIds.includes(feature.clientId)),
      ...pendingEdit.features,
    ];
  }
  return features.map((feature) =>
    feature.clientId === pendingEdit.feature.clientId ? pendingEdit.feature : feature,
  );
}

// Generate a new layer-wide field name that does not collide with existing attribute columns.
function nextLayerFieldName(features) {
  const names = new Set();
  features.forEach((feature) => {
    Object.keys(feature.properties ?? {}).forEach((key) => names.add(key));
  });

  let index = names.size + 1;
  let candidate = `field_${index}`;
  while (names.has(candidate)) {
    index += 1;
    candidate = `field_${index}`;
  }
  return candidate;
}

// Check whether any feature already has this attribute column name.
function layerHasField(features, fieldName) {
  return features.some((feature) => Object.prototype.hasOwnProperty.call(feature.properties ?? {}, fieldName));
}

// Rename one attribute key while preserving object order and the existing value.
function renamePropertyKey(properties, oldKey, newKey) {
  const next = {};
  Object.entries(properties).forEach(([key, value]) => {
    next[key === oldKey ? newKey : key] = value;
  });
  return next;
}

// Find the selected feature, preferring the current pending geometry if one exists.
function findLayerFeature(features, featureId, pendingEdit) {
  if (!featureId) return null;
  if (pendingEdit?.feature?.clientId === featureId) return pendingEdit.feature;
  if (pendingEdit?.kind === 'split') {
    return pendingEdit.features.find((feature) => feature.clientId === featureId) ?? null;
  }
  return features.find((feature) => feature.clientId === featureId) ?? null;
}

// Remove unsaved draft features from the current pending edit without touching saved database rows.
function removePendingFeatures(pendingEdit, clientIds) {
  if (!pendingEdit) return pendingEdit;
  if (pendingEdit.kind === 'split') {
    const nextFeatures = pendingEdit.features.filter((feature) => !clientIds.includes(feature.clientId));
    return nextFeatures.length > 0 ? { ...pendingEdit, features: nextFeatures } : null;
  }
  return clientIds.includes(pendingEdit.feature?.clientId) ? null : pendingEdit;
}

// Leaflet wraps the browser click event; Ctrl and Shift both mean "toggle this feature in selection".
function isToggleSelectionEvent(event) {
  const originalEvent = event?.originalEvent;
  return Boolean(originalEvent?.ctrlKey || originalEvent?.shiftKey);
}

// Auto-complete creates a new polygon from the drawn area after removing existing layer polygons.
function autoCompletePolygonFeature(drawnFeature, existingFeatures) {
  if (!isPolygonFeature(drawnFeature)) return null;
  const existingPolygons = existingFeatures.filter(isPolygonFeature).map(cleanFeatureForTurf);
  const drawnPolygon = cleanFeatureForTurf(drawnFeature);

  if (existingPolygons.length === 0) {
    return drawnPolygon;
  }

  try {
    const existingUnion = turf.union(turf.featureCollection(existingPolygons));
    if (!existingUnion) return drawnPolygon;
    const completed = turf.difference(turf.featureCollection([drawnPolygon, existingUnion]));
    return completed && isPolygonFeature(completed) ? completed : null;
  } catch {
    return drawnPolygon;
  }
}

// Cut selected polygon by subtracting a very narrow buffer around the drawn cut line.
function cutSelectedPolygonFeatures(selectedFeature, cutLineFeature) {
  if (!selectedFeature || !isPolygonFeature(selectedFeature)) return [];

  try {
    const cutBuffer = turf.buffer(cleanFeatureForTurf(cutLineFeature), 0.15, { units: 'meters' });
    const cutResult = turf.difference(turf.featureCollection([cleanFeatureForTurf(selectedFeature), cutBuffer]));
    if (!cutResult || !isPolygonFeature(cutResult)) return [];
    const parts = explodePolygonParts(cutResult);
    if (parts.length < 2) return [];
    return parts.map((part) => ({
      ...part,
      id: null,
      clientId: crypto.randomUUID(),
      properties: { ...(selectedFeature.properties ?? {}) },
    }));
  } catch {
    return [];
  }
}

// Convert a cut Polygon/MultiPolygon result into separate polygon features and table rows.
function explodePolygonParts(feature) {
  if (feature.geometry.type === 'Polygon') {
    return [feature];
  }

  if (feature.geometry.type !== 'MultiPolygon') {
    return [];
  }

  return feature.geometry.coordinates.map((coordinates) => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates,
    },
    properties: {},
  }));
}

// Keep Turf inputs free of app-only ids and stale properties.
function cleanFeatureForTurf(feature) {
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {},
  };
}

// Accept both Polygon and MultiPolygon because shapefile polygon layers can contain multipart polygons.
function isPolygonFeature(feature) {
  return feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon';
}

// Restrict Leaflet Draw tools to the current shapefile geometry family.
function drawOptionsForGeometry(geometryType = '') {
  const family = geometryFamily(geometryType);
  return {
    circle: false,
    circlemarker: false,
    marker: family === 'point',
    polyline: family === 'line',
    polygon: family === 'polygon' ? { allowIntersection: true, showArea: true } : false,
    rectangle: family === 'polygon',
  };
}

// Drag the selected point feature with app-owned logic so Save receives the moved coordinates.
function enablePointDrag(layer, datasetId, latestRef) {
  layer.on('mousedown', (event) => {
    L.DomEvent.stop(event);
    const map = layer._map;
    if (!map) return;
    map.dragging.disable();
    map.getContainer().classList.add('moving-feature');

    const move = (moveEvent) => {
      layer.setLatLng(moveEvent.latlng);
    };

    const finish = () => {
      map.off('mousemove', move);
      map.off('mouseup', finish);
      document.removeEventListener('mouseup', finish);
      map.dragging.enable();
      map.getContainer().classList.remove('moving-feature');
      const existing = layer.feature ?? {};
      const movedFeature = layer.toGeoJSON();
      latestRef.current.onPendingUpdate(datasetId, {
        ...movedFeature,
        id: existing.id ?? null,
        clientId: existing.clientId ?? latestRef.current.selectedFeatureId,
        properties: existing.properties ?? {},
      });
    };

    map.on('mousemove', move);
    map.on('mouseup', finish);
    document.addEventListener('mouseup', finish, { once: true });
  });
}

// Create a custom point tool instead of showing Leaflet Draw's full point edit toolbar.
function createPointCreateControl(map, activeCustomDrawRef) {
  const PointCreateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: () => {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control custom-point-control');
      const button = L.DomUtil.create('button', '', container);
      button.type = 'button';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/></svg>';
      button.setAttribute('aria-label', 'Create point');
      button.title = 'Create point';
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, 'click', (event) => {
        L.DomEvent.stop(event);
        if (activeCustomDrawRef.current) activeCustomDrawRef.current.disable();
        activeCustomDrawRef.current = new L.Draw.Marker(map);
        activeCustomDrawRef.current.enable();
      });
      return container;
    },
  });
  return new PointCreateControl();
}

// Create polygon-specific GIS construction tools that Leaflet Draw does not provide out of the box.
function createPolygonAdvancedControl(map, latestRef, polygonToolModeRef, activeCustomDrawRef) {
  const PolygonAdvancedControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: () => {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control polygon-advanced-control');
      const autoCompleteButton = L.DomUtil.create('button', '', container);
      const cutButton = L.DomUtil.create('button', '', container);

      autoCompleteButton.type = 'button';
      autoCompleteButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" class="autocomplete-icon"><path d="M6.5 8.5 12.5 4.5 18.5 8.5 16.5 17.5 8.5 17.5Z"/><circle cx="6.5" cy="8.5" r="2.6"/><circle cx="12.5" cy="4.5" r="2.6"/><circle cx="18.5" cy="8.5" r="2.6"/><circle cx="16.5" cy="17.5" r="2.6"/><circle cx="8.5" cy="17.5" r="2.6"/></svg>';
      autoCompleteButton.setAttribute('aria-label', 'Auto complete polygon');
      autoCompleteButton.title = 'Auto complete polygon';

      cutButton.type = 'button';
      cutButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" class="cut-polygon-icon"><rect x="5" y="7" width="14" height="12"/><path d="M12 3v18"/></svg>';
      cutButton.setAttribute('aria-label', 'Cut selected polygon');
      cutButton.title = 'Cut selected polygon';

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(autoCompleteButton, 'click', (event) => {
        L.DomEvent.stop(event);
        startCustomPolygonDraw(map, polygonToolModeRef, activeCustomDrawRef, 'autoComplete');
      });
      L.DomEvent.on(cutButton, 'click', (event) => {
        L.DomEvent.stop(event);
        if (!latestRef.current.selectedFeatureId) return;
        startCustomCutDraw(map, polygonToolModeRef, activeCustomDrawRef);
      });
      return container;
    },
  });
  return new PolygonAdvancedControl();
}

// Create a whole-feature move tool for selected line and polygon features.
function createMoveSelectedControl(map, editGroup, latestRef, moveStateRef) {
  const MoveControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: () => {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control custom-move-control');
      const button = L.DomUtil.create('button', '', container);
      button.type = 'button';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/><path d="M2 12h20"/><path d="m8 6 4-4 4 4"/><path d="m8 18 4 4 4-4"/><path d="m6 8-4 4 4 4"/><path d="m18 8 4 4-4 4"/></svg>';
      button.setAttribute('aria-label', 'Move selected feature');
      button.title = 'Select a line or polygon to move';
      button.disabled = true;
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, 'click', (event) => {
        L.DomEvent.stop(event);
        if (moveStateRef.current.active) {
          deactivateMoveFeature(map, moveStateRef);
          return;
        }
        activateMoveFeature(map, editGroup, latestRef, moveStateRef, button);
      });
      return container;
    },
  });
  return new MoveControl();
}

// Enable dragging the currently selected Leaflet path as a whole feature.
function activateMoveFeature(map, editGroup, latestRef, moveStateRef, button) {
  const selectedLayer = findEditableLeafletLayer(editGroup, latestRef.current.selectedFeatureId);
  if (!selectedLayer) return;

  deactivateMoveFeature(map, moveStateRef);
  moveStateRef.current = {
    active: true,
    button,
    layer: selectedLayer,
    latestRef,
  };
  button.classList.add('active');
  map.getContainer().classList.add('moving-feature');

  const startMove = (event) => {
    L.DomEvent.stop(event);
    moveStateRef.current.moving = true;
    moveStateRef.current.lastLatLng = event.latlng;
    map.dragging.disable();

    const move = (moveEvent) => {
      const state = moveStateRef.current;
      if (!state.moving || !state.layer || !state.lastLatLng) return;
      const deltaLat = moveEvent.latlng.lat - state.lastLatLng.lat;
      const deltaLng = moveEvent.latlng.lng - state.lastLatLng.lng;
      if (typeof state.layer.setLatLng === 'function' && typeof state.layer.getLatLng === 'function') {
        const currentLatLng = state.layer.getLatLng();
        state.layer.setLatLng(L.latLng(currentLatLng.lat + deltaLat, currentLatLng.lng + deltaLng));
      } else {
        state.layer.setLatLngs(translateLatLngs(state.layer.getLatLngs(), deltaLat, deltaLng));
      }
      state.lastLatLng = moveEvent.latlng;
    };

    const finish = () => {
      const state = moveStateRef.current;
      map.off('mousemove', move);
      map.off('mouseup', finish);
      document.removeEventListener('mouseup', finish);
      map.dragging.enable();
      if (!state.layer) return;
      commitMovedLayer(state.layer, latestRef);
      state.moving = false;
      state.lastLatLng = null;
    };

    map.on('mousemove', move);
    map.on('mouseup', finish);
    document.addEventListener('mouseup', finish, { once: true });
  };

  selectedLayer.on('mousedown', startMove);
  moveStateRef.current.startMove = startMove;
}

// Turn off whole-feature movement and remove temporary handlers/classes.
function deactivateMoveFeature(map, moveStateRef) {
  const state = moveStateRef.current;
  if (state.layer && state.startMove) {
    state.layer.off('mousedown', state.startMove);
  }
  if (state.layer && state.latestRef) {
    commitMovedLayer(state.layer, state.latestRef);
  }
  if (state.button) {
    state.button.classList.remove('active');
  }
  map.getContainer().classList.remove('moving-feature');
  moveStateRef.current = { active: false };
}

// Store the currently dragged Leaflet path as a pending geometry edit before Save reads state.
function commitMovedLayer(layer, latestRef) {
  const existing = layer.feature ?? {};
  const feature = layer.toGeoJSON();
  latestRef.current.onPendingUpdate(latestRef.current.editingDatasetId, {
    ...feature,
    id: existing.id ?? null,
    clientId: existing.clientId ?? latestRef.current.selectedFeatureId,
    properties: existing.properties ?? {},
  });
}

// Find the selected editable path inside the edit feature group.
function findEditableLeafletLayer(editGroup, selectedFeatureId) {
  let selectedLayer = null;
  editGroup.eachLayer((layer) => {
    if (layer.feature?.clientId === selectedFeatureId) {
      selectedLayer = layer;
    }
  });
  return selectedLayer;
}

// Recursively translate line/polygon LatLng arrays while preserving their nested shape.
function translateLatLngs(latLngs, deltaLat, deltaLng) {
  return latLngs.map((item) => {
    if (Array.isArray(item)) return translateLatLngs(item, deltaLat, deltaLng);
    return L.latLng(item.lat + deltaLat, item.lng + deltaLng);
  });
}

// Start a custom polygon draw mode and let the global CREATED handler process the result.
function startCustomPolygonDraw(map, polygonToolModeRef, activeCustomDrawRef, mode) {
  if (activeCustomDrawRef.current) activeCustomDrawRef.current.disable();
  polygonToolModeRef.current = mode;
  activeCustomDrawRef.current = new L.Draw.Polygon(map, {
    allowIntersection: true,
    showArea: true,
    shapeOptions: { color: '#f97316', weight: 3 },
  });
  activeCustomDrawRef.current.enable();
}

// Start a custom line draw mode for splitting the selected polygon.
function startCustomCutDraw(map, polygonToolModeRef, activeCustomDrawRef) {
  if (activeCustomDrawRef.current) activeCustomDrawRef.current.disable();
  polygonToolModeRef.current = 'cut';
  activeCustomDrawRef.current = new L.Draw.Polyline(map, {
    shapeOptions: { color: '#b91c1c', weight: 3, dashArray: '6 4' },
  });
  activeCustomDrawRef.current.enable();
}

// Create a one-click map delete button without Leaflet Draw's Save/Cancel/Clear All delete mode.
function createDeleteSelectedControl(latestRef) {
  const DeleteControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: () => {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control custom-delete-control');
      const button = L.DomUtil.create('button', '', container);
      button.type = 'button';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';
      button.setAttribute('aria-label', 'Delete selected feature');
      button.title = 'Select a feature to delete';
      button.disabled = true;
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, 'click', (event) => {
        L.DomEvent.stop(event);
        if ((latestRef.current.selectedFeatureIds?.length ?? 0) === 0) return;
        latestRef.current.onDeleteSelected();
      });
      return container;
    },
  });
  return new DeleteControl();
}

// Add a top-right previous extent button that returns to the last pan/zoom view.
function createPreviousExtentControl(map, viewHistoryRef, lastViewRef, skipViewHistoryRef, previousExtentButtonRef) {
  const PreviousExtentControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: () => {
      const container = L.DomUtil.create('div', 'leaflet-control previous-extent-control');
      const button = L.DomUtil.create('button', '', container);
      button.type = 'button';
      button.disabled = true;
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 7 7v4"/></svg>';
      button.setAttribute('aria-label', 'Go to previous map extent');
      button.title = 'Previous extent';
      previousExtentButtonRef.current = button;
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, 'click', (event) => {
        L.DomEvent.stop(event);
        const previousView = viewHistoryRef.current.pop();
        if (!previousView) return;
        skipViewHistoryRef.current = true;
        lastViewRef.current = previousView;
        button.disabled = viewHistoryRef.current.length === 0;
        map.setView(previousView.center, previousView.zoom, { animate: true });
      });
      return container;
    },
  });
  return new PreviousExtentControl();
}

// Add a top-right Home button that returns the map to the default Pakistan view.
function createHomeControl(map) {
  const HomeControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: () => {
      const container = L.DomUtil.create('div', 'leaflet-control home-control');
      const button = L.DomUtil.create('button', '', container);
      button.type = 'button';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>';
      button.setAttribute('aria-label', 'Return to home map view');
      button.title = 'Home view';
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, 'click', (event) => {
        L.DomEvent.stop(event);
        map.setView(INITIAL_MAP_CENTER, INITIAL_MAP_ZOOM, { animate: true });
      });
      return container;
    },
  });
  return new HomeControl();
}

// Compare Leaflet views with a small tolerance so tiny floating-point movement is ignored.
function sameMapView(firstView, secondView) {
  if (!firstView || !secondView) return false;
  return firstView.zoom === secondView.zoom
    && Math.abs(firstView.center.lat - secondView.center.lat) < 0.000001
    && Math.abs(firstView.center.lng - secondView.center.lng) < 0.000001;
}

// Read the live Leaflet view instead of relying on React state during fast redraw cycles.
function currentMapView(map) {
  return { center: map.getCenter(), zoom: map.getZoom() };
}

// Restore a captured view without adding that restore action to the previous-extent history.
function restoreMapView(map, view, skipViewHistoryRef) {
  skipViewHistoryRef.current = !sameMapView(currentMapView(map), view);
  map.setView(view.center, view.zoom, { animate: false });
}

// Add a top-right basemap gallery so users can choose the map style they prefer.
function createBasemapGalleryControl(map, basemaps, baseLayerRef, currentBasemapRef) {
  const BasemapGalleryControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: () => {
      const container = L.DomUtil.create('div', 'leaflet-control basemap-gallery-control');
      const button = L.DomUtil.create('button', 'basemap-gallery-toggle', container);
      button.type = 'button';
      button.innerHTML = '<span></span><span></span><span></span><span></span>';
      button.setAttribute('aria-label', 'Open basemap gallery');
      button.title = 'Choose basemap';
      const menu = L.DomUtil.create('div', 'basemap-gallery-menu', container);
      const header = L.DomUtil.create('div', 'basemap-gallery-header', menu);
      const title = L.DomUtil.create('strong', '', header);
      title.textContent = 'Basemap';
      const close = L.DomUtil.create('button', 'basemap-gallery-close', header);
      close.type = 'button';
      close.textContent = 'x';
      close.title = 'Close basemap gallery';
      const grid = L.DomUtil.create('div', 'basemap-gallery-grid', menu);
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, 'click', (event) => {
        L.DomEvent.stop(event);
        container.classList.toggle('open');
      });
      L.DomEvent.on(close, 'click', (event) => {
        L.DomEvent.stop(event);
        container.classList.remove('open');
      });

      Object.entries(basemaps).forEach(([key, basemap]) => {
        const option = L.DomUtil.create('button', 'basemap-option', grid);
        option.type = 'button';
        option.title = `Use ${basemap.label} basemap`;
        const image = L.DomUtil.create('span', 'basemap-option-thumb', option);
        image.style.backgroundImage = `url("${basemap.thumb}")`;
        const label = L.DomUtil.create('span', 'basemap-option-label', option);
        label.textContent = basemap.label;
        if (key === currentBasemapRef.current) option.classList.add('active');
        L.DomEvent.on(option, 'click', (event) => {
          L.DomEvent.stop(event);
          if (baseLayerRef.current) map.removeLayer(baseLayerRef.current);
          baseLayerRef.current = basemap.layer;
          currentBasemapRef.current = key;
          baseLayerRef.current.addTo(map);
          menu.querySelectorAll('.basemap-option').forEach((item) => item.classList.remove('active'));
          option.classList.add('active');
          container.classList.remove('open');
        });
      });
      return container;
    },
  });
  return new BasemapGalleryControl();
}

// Normalize single and multi geometry names into the editing families.
function geometryFamily(geometryType = '') {
  if (geometryType.toLowerCase().includes('point')) return 'point';
  if (geometryType.toLowerCase().includes('linestring')) return 'line';
  if (geometryType.toLowerCase().includes('polygon')) return 'polygon';
  return 'unknown';
}

// Normalize server GeoJSON into client rows with a stable clientId for table/map selection.
function normalizeFeatures(rawFeatures) {
  return rawFeatures.map((feature) => ({
    ...feature,
    type: 'Feature',
    clientId: feature.id ?? crypto.randomUUID(),
    properties: feature.properties ?? {},
  }));
}

// Convert the selected Leaflet Draw group back into GeoJSON feature state.
function readFeaturesFromLayerGroup(layerGroup) {
  const features = [];
  layerGroup.eachLayer((layer) => {
    const existing = layer.feature ?? {};
    const feature = layer.toGeoJSON();
    features.push({
      ...feature,
      id: existing.id ?? null,
      clientId: existing.clientId ?? crypto.randomUUID(),
      properties: existing.properties ?? {},
    });
  });
  return features;
}

// Remove client-only ids before sending GeoJSON DTOs to the backend.
function stripClientId(feature) {
  const dto = { ...feature };
  delete dto.clientId;
  return dto;
}

// Keep selection stable after save; newly inserted features receive real database ids after save.
function resolveSelectedAfterSave(features, selectedFeatureId) {
  if (!selectedFeatureId) return null;
  return features.some((feature) => feature.clientId === selectedFeatureId)
    ? selectedFeatureId
    : null;
}

// Give newly drawn features the same attribute columns as the shapefile they belong to.
function createEmptyProperties(features) {
  const names = new Set();
  features.forEach((feature) => {
    Object.keys(feature.properties ?? {}).forEach((key) => names.add(key));
  });
  return Object.fromEntries([...names].map((name) => [name, '']));
}

// Style line and polygon features based on layer color, active layer, and selected feature state.
function featureStyle(color, selected, active) {
  return {
    color: selected ? '#f97316' : color,
    fillColor: color,
    fillOpacity: active ? 0.32 : 0.16,
    opacity: active ? 1 : 0.72,
    weight: selected ? 4 : active ? 3 : 2,
  };
}

// Style point features as circle markers so colors and selection are visible.
function pointStyle(color, selected) {
  return {
    radius: selected ? 8 : 6,
    color: selected ? '#f97316' : color,
    fillColor: color,
    fillOpacity: 0.75,
    weight: selected ? 3 : 2,
  };
}

// Render table values safely, including object-like JSON values from PostgreSQL jsonb.
function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

createRoot(document.getElementById('root')).render(<App />);
