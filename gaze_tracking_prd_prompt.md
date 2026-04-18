# Context
We are developing a webcam-based eye-tracking system (using WebGazer) for a web application. Current issues involve high inaccuracy, noise, and unintended UI interactions (e.g., text moving or triggering when the user isn't actively reading it). 

# Objective
Please generate a full Technical Design Document (TDD) that details the implementation of four specific "software-only" approaches to stabilize gaze tracking and improve interaction accuracy. The implementation should be modular and integrate into our existing JavaScript/WebGazer pipeline.

# Features to Design

### Feature A: Gaze Snapping (DOM Magnetism)
Instead of relying freely on raw (x,y) screen coordinates, the system should intelligently snap the gaze point to the nearest logical DOM element (like a `<p>` tag or text block) when the raw gaze falls into empty margins or near the bounding box.
*   **Requirements:**
    *   Calculate the distance from the raw gaze point to the nearest paragraph's bounding box.
    *   Define a configurable "magnetic radius" or padding around elements.
    *   If the gaze is outside the element but within the magnetic radius, override the gaze data to snap exactly onto the text block.
    *   Output the "snapped" element to the application state to reduce jittery false-negatives when reading edges.

### Feature B: Reading Pattern Recognition
Simple "dwell timers" (triggering an event if the gaze stays in one absolute area) are highly susceptible to false positives (e.g., the user is zoning out or staring). We need a sequence-based recognizer.
*   **Requirements:**
    *   Detect horizontal saccades (left-to-right eye movements) followed by quick return sweeps (right-to-left) characteristics of natural reading.
    *   Calculate a "Reading Confidence Score" by analyzing the rolling window of the last N gaze coordinates.
    *   Only trigger active UI interventions (e.g., text alterations/expansion) when the confidence score confirms the user is actively reading, ignoring static staring.

### Feature C: Implicit/Silent Recalibration
Calibration drifts over time as the user naturally shifts in their chair. We need to continuously and silently feed new calibration points back into the regression model during normal usage to maintain accuracy.
*   **Requirements:**
    *   Hook into high-intent UI interactions: mouse clicks, button presses, dragging, or text selection.
    *   At the exact moment of physical interaction, capture the precise (x,y) coordinate of the cursor.
    *   Feed these points silently into WebGazer (`webgazer.recordScreenPosition(x, y, 'click')`).
    *   Implement rate-limiting and outlier-rejection (e.g., don't re-train if the click is registered too far from the current predicted gaze, preventing bad data ingestion).

### Feature D: Kalman Filtering for Gaze Smoothing
The current system typically uses basic Single-Pole IIR Low-Pass filters. This creates visual drag/lag and doesn't reject noise anomalies gracefully. We need to upgrade to a predictive filter.
*   **Requirements:**
    *   Implement a 2D Kalman filter for (x,y) coordinates to process the raw output stream from WebGazer.
    *   Use the filter to predict movement direction and gracefully handle noisy frames, momentary pupil-tracking loss, or blink interferences.
    *   Expose adjustable tuning parameters (`processNoise`, `measurementNoise`) to balance responsiveness (during saccades) and stability (during fixations).

# Output Expectations
Please provide the following in your Technical Design Document:
1.  **Architecture & Data Pipeline:** A clear explanation or diagram of the data flow (e.g., Raw Gaze -> Kalman Filter -> Gaze Snap -> Pattern Recognition -> UI State).
2.  **Implementation Code / Pseudo-code:** Specifically focus on the logic algorithms for the DOM Magnetism math, the Reading Pattern heuristic, and the Kalman Filter setup.
3.  **Performance & Edge Cases:** What framerate impacts or state-management concerns should we anticipate? How do we handle edge cases like scrolling while reading?
