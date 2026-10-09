import { collection, doc, setDoc, getDoc, getDocs, deleteDoc, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';
import type { Workflow } from '../../shared/types/workflow';

export class FirestoreStorageManager {
  private static COLLECTION_NAME = 'workflows';

  static async saveWorkflow(workflow: Workflow): Promise<void> {
    try {
      const docRef = doc(db, this.COLLECTION_NAME, workflow.id);
      
      // Sanitize to remove any undefined values which Firestore completely rejects
      const sanitize = (obj: any): any => {
        if (obj === undefined) return null;
        if (obj === null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(sanitize);
        const newObj: any = {};
        for (const key in obj) {
          if (obj[key] !== undefined) {
            newObj[key] = sanitize(obj[key]);
          }
        }
        return newObj;
      };

      const workflowData = sanitize({
        ...workflow,
        createdAt: workflow.createdAt, 
        updatedAt: Date.now()
      });
      
      await setDoc(docRef, workflowData);
      console.log('Workflow saved to Firestore successfully.');
    } catch (error) {
      console.error('Error saving workflow to Firestore:', error);
      throw error;
    }
  }

  static async getWorkflow(id: string): Promise<Workflow | null> {
    try {
      const docRef = doc(db, this.COLLECTION_NAME, id);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        return docSnap.data() as Workflow;
      }
      return null;
    } catch (error) {
      console.error('Error fetching workflow from Firestore:', error);
      throw error;
    }
  }

  static async getUserWorkflows(userId: string): Promise<Workflow[]> {
    try {
      const workflowsRef = collection(db, this.COLLECTION_NAME);
      const q = query(
        workflowsRef, 
        where("ownerId", "==", userId)
      );
      
      const querySnapshot = await getDocs(q);
      const workflows: Workflow[] = [];
      
      querySnapshot.forEach((doc) => {
        workflows.push(doc.data() as Workflow);
      });
      
      // Sort by updatedAt descending in memory to avoid needing a composite index in Firestore
      workflows.sort((a, b) => {
        const timeA = new Date(a.updatedAt).getTime();
        const timeB = new Date(b.updatedAt).getTime();
        return timeB - timeA;
      });
      
      return workflows;
    } catch (error) {
      console.error('Error fetching user workflows from Firestore:', error);
      throw error;
    }
  }

  static async deleteWorkflow(id: string): Promise<void> {
    try {
      const docRef = doc(db, this.COLLECTION_NAME, id);
      await deleteDoc(docRef);
    } catch (error) {
      console.error('Error deleting workflow:', error);
      throw error;
    }
  }
}
